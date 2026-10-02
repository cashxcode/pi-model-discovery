import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { validateBaseUrl } from "../src/shared/validation.js";
import { loadConfig } from "../src/config/loader.js";
import { discoverOpenAICompat } from "../src/discovery/openai-compat.js";
import { writeJson } from "./support/fixtures.js";
import { createTestApiKey } from "./support/secrets.js";

const privateHosts = ["10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255"];
const otherHosts = ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "8.8.8.8", "0.0.0.0", "server.local", "10.example.com", "127.example.com", "[fd00::1]", "[::ffff:192.168.1.1]"];

test("private HTTP opt-in covers exactly RFC 1918 IPv4 ranges independently of loopback opt-in", () => {
  for (const host of privateHosts) {
    const url = `http://${host}:11234/v1`;
    assert.equal(validateBaseUrl(url, { allowLocalHttp: true }).ok, false, host);
    assert.equal(validateBaseUrl(url, { allowPrivateHttp: true }).ok, true, host);
  }
  for (const host of otherHosts) {
    assert.equal(validateBaseUrl(`http://${host}/v1`, { allowLocalHttp: true, allowPrivateHttp: true }).ok, false, host);
  }
});

test("localhost defaults and remote HTTPS remain compatible", () => {
  for (const host of ["localhost", "127.0.0.1", "127.255.255.255", "[::1]"]) {
    assert.equal(validateBaseUrl(`http://${host}/v1`, { allowLocalHttp: true }).ok, true, host);
    assert.equal(validateBaseUrl(`http://${host}/v1`, { allowPrivateHttp: true }).ok, false, host);
  }
  assert.equal(validateBaseUrl("https://remote.example.com/v1").ok, true);
});

test("private HTTP does not bypass URL or metadata restrictions", () => {
  for (const url of ["http://user:pass@192.168.1.2/v1", "http://192.168.1.2/v1?key=x", "http://192.168.1.2/v1#x", "ftp://192.168.1.2/v1", "http://10.999.1.2", "not a url", "http://169.254.169.254", "https://169.254.1.2", "http://metadata.google.internal", "https://metadata.google.internal"]) {
    assert.equal(validateBaseUrl(url, { allowLocalHttp: true, allowPrivateHttp: true }).ok, false, url);
  }
});

test("explicit provider opt-in is strict, scoped, and used by discovery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pmd-remote-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  const apiKey = createTestApiKey("remote-host");
  writeJson(modelsJsonPath, { providers: {} });
  writeJson(authJsonPath, {});
  writeJson(configPath, {
    autoImport: { enabled: false },
    providers: [true, false, undefined, "true", 1].map((allowPrivateHttp, index) => ({
      id: `lan-${index}`, baseUrl: "http://192.168.1.20:11234/v1/", allowPrivateHttp,
      api: "openai-completions", apiKey, discovery: { type: "openai-compat" },
    })),
  });
  const { config } = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  assert.deepEqual(config.providers.map((provider) => provider.id), ["lan-0"]);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(String(url));
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${apiKey}`);
    return new Response(JSON.stringify({ data: [{ id: "lan-chat-model" }] }), { headers: { "content-type": "application/json" } });
  });
  const models = await discoverOpenAICompat(config.providers[0]!);
  assert.deepEqual(requests, ["http://192.168.1.20:11234/v1/models"]);
  assert.equal(models[0]?.id, "lan-chat-model");
});
