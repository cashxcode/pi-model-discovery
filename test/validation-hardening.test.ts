import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CacheManager } from "../src/cache/manager.js";
import type { DiscoveredModel } from "../src/cache/types.js";
import { loadConfig } from "../src/config/loader.js";
import type { ProviderConfigEntry } from "../src/config/types.js";
import { applyModelFilters, safeFetchJson } from "../src/discovery/helpers.js";
import { createTestApiKey } from "./support/secrets.js";
import { writeJson } from "./support/fixtures.js";

const TEST_API_KEY = createTestApiKey("validation-hardening");

const provider: ProviderConfigEntry = {
  id: "hardening-provider",
  baseUrl: "https://hardening.example.invalid/v1",
  apiKey: TEST_API_KEY,
  api: "openai-completions" as ProviderConfigEntry["api"],
  authHeader: true,
  headers: {},
  maxModels: 2,
  discovery: {
    type: "openai-compat",
    enabled: true,
    headers: {},
    timeoutMs: 1000,
    ttlMs: 60_000,
    includeDetails: false,
    allowModels: ["gpt"],
    blockModels: ["blocked"],
  },
  defaults: {},
  modelDefaults: {},
  source: "explicit",
};

const model: DiscoveredModel = {
  id: "gpt-live",
  name: "GPT Live",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  sources: { test: true },
};

test("allow/block filters dedupe and cap discovered model IDs before registration", () => {
  assert.deepEqual(applyModelFilters(["gpt-live", "gpt-blocked", "claude", "gpt-live", "gpt-extra"], provider), ["gpt-live", "gpt-extra"]);
});

test("model filters are uncapped when maxModels is not explicitly configured", () => {
  const uncappedProvider = { ...provider, maxModels: undefined, discovery: { ...provider.discovery, allowModels: [], blockModels: [] } };
  assert.deepEqual(applyModelFilters(["model-a", "model-b", "model-a", "model-c"], uncappedProvider), ["model-a", "model-b", "model-c"]);
});

test("config normalization validates registration import mode and caps pagination boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-validation-"));
  const configPath = join(dir, "config.json");
  writeJson(configPath, {
    autoImport: { enabled: false },
    registration: { importMode: "sync" },
    providers: [
      {
        id: "pagination-provider",
        baseUrl: "https://pagination.example.invalid/v1",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat", pagination: { maxPages: 999 } },
      },
    ],
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath: join(dir, "models.json"), authJsonPath: join(dir, "auth.json") });

  assert.equal(result.config.registration?.importMode, "sync");
  assert.equal(result.config.registrationOwnership?.onConflict, "merge");
  assert.equal(result.config.providers[0]?.discovery.pagination?.maxPages, 100);
  assert.ok(result.warnings.some((warning) => warning.includes("maxPages") && warning.includes("100")));
});

test("absolute discovery endpoints and models.dev URLs are validated before network use", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-url-validation-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(modelsJsonPath, {
    providers: {
      "auto-one": {
        baseUrl: "https://auto.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  writeJson(authJsonPath, { "auto-one": { type: "api_key", key: TEST_API_KEY } });
  writeJson(configPath, {
    modelsDev: { url: "https://169.254.169.254/latest/meta-data" },
    autoImport: {
      discovery: {
        endpointPathByProvider: {
          "auto-one": "https://169.254.169.254/latest/meta-data",
        },
      },
    },
    providers: [
      {
        id: "unsafe-endpoint",
        baseUrl: "https://unsafe.example.invalid/v1",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat", endpointPath: "https://169.254.169.254/latest/meta-data" },
      },
      {
        id: "safe-endpoint",
        baseUrl: "https://safe.example.invalid/v1",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat", endpointPath: "https://catalog.example.invalid/models" },
      },
    ],
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  const providerIds = result.config.providers.map((entry) => entry.id);

  assert.deepEqual(providerIds.sort(), ["auto-one", "safe-endpoint"]);
  assert.equal(result.config.providers.find((entry) => entry.id === "safe-endpoint")?.discovery.endpointPath, "https://catalog.example.invalid/models");
  assert.equal(result.config.providers.find((entry) => entry.id === "auto-one")?.discovery.endpointPath, undefined);
  assert.equal(result.config.modelsDev.url, "https://models.dev/api.json");
  assert.ok(result.warnings.some((warning) => warning.includes("providers[0].discovery.endpointPath") && warning.includes("skipping provider unsafe-endpoint")));
  assert.ok(result.warnings.some((warning) => warning.includes("autoImport.discovery.endpointPathByProvider.auto-one")));
  assert.ok(result.warnings.some((warning) => warning.includes("modelsDev.url")));
});

test("network discovery helper returns redacted non-throwing errors for HTTP, JSON, and abort failures", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/http")) return new Response(JSON.stringify({ error: "nope" }), { status: 503 });
    if (url.endsWith("/json")) return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/text")) return new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });

  const http = await safeFetchJson("https://network.example.invalid/http", { method: "GET" }, 1000);
  const json = await safeFetchJson("https://network.example.invalid/json", { method: "GET" }, 1000);
  const text = await safeFetchJson("https://network.example.invalid/text", { method: "GET" }, 1000);
  const abort = await safeFetchJson("https://network.example.invalid/abort", { method: "GET" }, 1);

  assert.deepEqual(
    [http, json, text, abort].map((result) => ({ ok: result.ok, hasError: typeof result.error === "string" && result.error.length > 0 })),
    [
      { ok: false, hasError: true },
      { ok: false, hasError: true },
      { ok: false, hasError: true },
      { ok: false, hasError: true },
    ],
  );
  assert.match(text.error ?? "", /expected JSON response/);
});

test("cache pruning removes disabled provider entries without touching active provider cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-prune-"));
  const cachePath = join(dir, "cache.json");
  const manager = new CacheManager(cachePath);
  await manager.replaceAll({ active: { fetchedAt: new Date().toISOString(), ttlMs: 60_000, authoritative: true, models: [model] }, stale: { fetchedAt: new Date().toISOString(), ttlMs: 60_000, authoritative: true, models: [] } });

  assert.deepEqual(await manager.pruneProviders(new Set(["active"])), ["stale"]);
  assert.equal(manager.read().providers.active?.models[0]?.id, "gpt-live");
  assert.equal(manager.read().providers.stale, undefined);
});

test("targeted cache pruning preserves skipped auto-import cache entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-targeted-prune-"));
  const cachePath = join(dir, "cache.json");
  const manager = new CacheManager(cachePath);
  await manager.replaceAll({
    excluded: { fetchedAt: new Date().toISOString(), ttlMs: 60_000, authoritative: true, models: [] },
    skippedAutoImport: { fetchedAt: new Date().toISOString(), ttlMs: 60_000, authoritative: true, models: [model] },
  });

  assert.deepEqual(await manager.pruneProviderIds(new Set(["excluded"])), ["excluded"]);
  assert.equal(manager.read().providers.excluded, undefined);
  assert.equal(manager.read().providers.skippedAutoImport?.models[0]?.id, "gpt-live");
});

test("private-network http baseUrl is rejected by default and accepted only with allowPrivateHttp", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pmd-private-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(modelsJsonPath, { providers: {} });
  writeJson(authJsonPath, {});

  const providersFor = (baseUrl: string, extra: Record<string, unknown> = {}) => {
    const configPath = join(dir, "config.json");
    writeJson(configPath, {
      autoImport: { enabled: false },
      providers: [
        { id: "lan-provider", baseUrl, api: "openai-completions", apiKey: TEST_API_KEY, discovery: { type: "openai-compat" }, ...extra },
      ],
    });
    return loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath }).config.providers;
  };

  assert.equal(providersFor("http://10.120.1.20:11234/v1").length, 0);
  const accepted = providersFor("http://10.120.1.20:11234/v1", { allowPrivateHttp: true });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.baseUrl, "http://10.120.1.20:11234/v1");
  assert.equal(providersFor("http://192.168.1.5:8080/v1", { allowPrivateHttp: true }).length, 1);
  assert.equal(providersFor("http://172.20.0.1/v1", { allowPrivateHttp: true }).length, 1);
  assert.equal(providersFor("http://172.32.0.1/v1", { allowPrivateHttp: true }).length, 0);
  assert.equal(providersFor("http://8.8.8.8/v1", { allowPrivateHttp: true }).length, 0);
  assert.equal(providersFor("http://169.254.169.254/v1", { allowPrivateHttp: true }).length, 0);
});
