<div align="center">

# pi-model-discovery

[![npm version](https://img.shields.io/npm/v/pi-model-discovery?style=for-the-badge)](https://www.npmjs.com/package/pi-model-discovery)
[![License](https://img.shields.io/github/license/MasuRii/pi-model-discovery?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y01PSSVR)

`pi-model-discovery` is a Pi extension that discovers provider models, enriches metadata, caches results, and registers them dynamically with `pi.registerProvider()` for `/scoped-models` and the `/pi-model-discovery` catalog.

</div>

## Features

- Auto-imports eligible provider definitions from `agent/models.json` and active API-key credentials from `agent/auth.json`.
- Uses built-in read-only discovery profiles for supported auth-only providers such as NVIDIA, Cloudflare Workers AI, Cerebras, Qwen, Xiaomi, Cline, and Kilo.
- Discovers OpenAI-compatible, Ollama, Anthropic-compatible, OpenAI Responses, LM Studio, llama.cpp, and static provider catalogs.
- Enriches discovered models with metadata from supported catalog sources and preserves free/paid classification as best-effort metadata.
- Registers cached models synchronously on startup/reload, then refreshes stale providers in the background.
- Writes optional debug logs only to `debug/debug.log` under this extension directory when `debug` is enabled.

## Installation

### Remote-host fork branch

Install this fork’s remote-host implementation with:

```bash
pi install git:github.com/cashxcode/pi-model-discovery@remote-host-support
```

If replacing the npm version, back up its `config.json` outside the package directory first, then run `pi remove npm:pi-model-discovery` to avoid loading both copies. Restore your config in the fork’s extension directory and add `allowPrivateHttp` to the LAN provider as shown below. The npm package and upstream repository commands below install the original release.

### npm package

```bash
pi install npm:pi-model-discovery
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-model-discovery
```

### Local extension folder

Place this folder in one of Pi's extension discovery paths:

```text
~/.pi/agent/extensions/pi-model-discovery
.pi/extensions/pi-model-discovery
```

Pi discovers the extension through the root `index.ts` entry listed in `package.json`.

## Usage

Discovery is automatic. On `session_start` and `/reload`, `pi-model-discovery` reads eligible providers and credentials from `agent/models.json` and `agent/auth.json`, refreshes stale providers in the background, and registers discovered models through `pi.registerProvider()`. No command needs to be run to trigger discovery.

Use Pi's built-in commands to select discovered models once they are registered:

- `/scoped-models` — enable/disable registered models for Ctrl+P cycling.
- `/model` — open the model selector.

To inspect the discovery catalog itself (cache freshness, authoritative fallback state, search/filter controls, and per-model metadata), open the read-only TUI:

```text
/pi-model-discovery
```

This command only views the catalog; it does not trigger discovery. Models registered by Pi built-ins or by other extensions appear alongside models known to `pi-model-discovery`.

### Quick start

1. Install the extension (see [Installation](#installation)).
2. Start `pi`. Discovery runs automatically in the background on session start.
3. Run `/scoped-models` to enable newly discovered models for Ctrl+P cycling.
4. (Optional) Run `/pi-model-discovery` to inspect cache metadata and discovery status.

### Standalone operation

`pi-model-discovery` has no hard dependency on other extensions. It loads and runs correctly when installed alone, and the `/pi-model-discovery` catalog shows every model in Pi's runtime registry, including Pi built-ins. To avoid duplicate ownership, providers that Pi already manages are not re-discovered: auto-import skips any provider that is both a Pi built-in and has an `auth.json` credential, and the registrar filters out discovered models that match Pi built-in model IDs. With no custom `providers` configured, the extension adds nothing on top of Pi's defaults beyond catalog visibility; to discover models from additional auth-only providers (e.g. SambaNova, Novita, DeepInfra), local servers (Ollama, LM Studio, llama.cpp), or custom OpenAI/Anthropic-compatible endpoints, add entries under `providers` in `config.json` (see [Configuration](#configuration)).

## Configuration

Runtime configuration lives in `config.json` at the extension root. A starter template is included at `config/config.example.json`.

By default, `config.json` can leave `providers` empty. With `autoImport.enabled` set to `true` (the default), the extension reads active credentials from `agent/auth.json`, reuses provider metadata from `agent/models.json` when available, falls back to built-in read-only model-list profiles, and skips unsupported/OAuth/missing-auth entries with redacted debug diagnostics only when `debug` is enabled.

Manual `providers` remain supported for custom endpoints or overrides. Explicit providers take precedence over auto-imported providers with the same ID. Keep manual secrets in environment variables with `${ENV_VAR}` references; do not place raw keys in config files. `debug` defaults to `false`; when enabled, logs are written only to `debug/debug.log` in this extension directory.

`baseUrl` values are validated before any network request. Use `https:` for remote providers; `http:` is accepted only for localhost/127.x development endpoints such as Ollama, LM Studio, or local proxies. URLs with credentials, query strings, fragments, or known metadata-service hosts are rejected. To use a server on another machine over plain `http:`, set `allowPrivateHttp: true` on that provider (default `false`); it permits only private-network IPv4 addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), and public hosts still require `https:`.

### A model server on another machine

For Pi on a laptop connecting to an OpenAI-compatible LAN server, add an explicit provider in `config.json`:

```json
{
  "providers": [
    {
      "id": "mlx-serve",
      "baseUrl": "http://192.168.1.20:11234/v1",
      "allowPrivateHttp": true,
      "api": "openai-completions",
      "apiKey": "${MLX_SERVE_API_KEY}",
      "discovery": { "type": "openai-compat" }
    }
  ]
}
```

Replace the example IP with your server's LAN IPv4 address and set `MLX_SERVE_API_KEY` in the environment that launches Pi. The server must listen on its LAN interface, and its port must be reachable from the laptop. Restart Pi or run `/reload`, then use `/pi-model-discovery` and `/model` to inspect and select a discovered model.

`allowPrivateHttp` must be the JSON boolean `true`, applies only to that explicit provider, and defaults to `false`. Auto-import does not opt in; define an explicit provider with the same ID to override it. Private DNS names (including `.local`), private IPv6, and public HTTP endpoints are not enabled by this option. Existing localhost, IPv4 loopback, IPv6 loopback, and HTTPS configurations need no changes.

OpenAI-compatible discovery reads a positive context window from `context_length`, then `max_model_len`, then `meta.context_length`. This includes mlx-serve's effective configured limit. `meta.model_max_tokens` is not interpreted as an output-token limit. Missing or invalid values leave the existing catalog/cache/default fallback behavior intact.

To follow server settings automatically, remove that model's `contextWindow` from `modelDefaults` and any provider-level `defaults.contextWindow`; explicit overrides take priority. Successful discovery refreshes replace previously cached context limits, including decreases. Discovery runs on startup or `/reload` when the provider cache has expired. With `ttlMs: 60000`, wait at least a minute after the previous successful discovery, then restart Pi or run `/reload`. This is not continuous polling; cached values can appear briefly while the background refresh completes. Cache-only mode and failed requests retain cached metadata.

HTTP sends API keys, prompts, and responses without encryption. Use this option only on a trusted network; use HTTPS or an SSH tunnel for encrypted transport. This flag validates the configured base URL; it is not a network firewall or a redirect policy.

Use `providers[].discovery.allowModels` and `providers[].discovery.blockModels` as substring filters on discovered model IDs. Discovery is uncapped by default; set top-level `maxModels` or `providers[].maxModels` only when you want an explicit positive model limit. Use `providers[].modelDefaults` for explicit per-model metadata overrides and `providers[].fallbackModelIds` when a provider should still register known models after discovery fails and no cache exists.

Provider IDs are a compatibility decision:

- Provider IDs with user credentials owned by Pi Mono remain Pi Mono-managed and are not auto-imported for duplicate ownership. Explicit providers still use this extension config.
- New provider IDs are isolated and use the API key supplied in this extension config.

Discovered model IDs are preserved exactly as returned by endpoints, so enabled model patterns use `providerId/modelId`. Before dynamic registration, optional Pi built-in model data is filtered by exact and provider-canonical IDs so `pi-model-discovery` does not register duplicate models already supplied by Pi built-ins.

`registration.importMode` defaults to `replace` for backward compatibility on non-managed providers. Providers owned by pi-multi-auth default to merge behavior during explicit ownership conflicts so credential ownership remains with pi-multi-auth. Advanced callers can use `merge` to preserve stale `pi-model-discovery` entries and manual model overrides, or `sync` to remove stale `pi-model-discovery` entries while still preserving manual entries and overrides.

## Runtime behavior

- Registers fresh cached models synchronously on `session_start` and `resources_discover` (`/reload`).
- Suppresses live discovery while an authoritative cache entry is within its provider TTL, and backs off for five minutes after non-authoritative discovery failures.
- Debounces concurrent background refreshes and re-registers changed providers after discovery.
- Honors `PI_MODEL_DISCOVERY_CACHE_ONLY=1` for delegated/cache-only runtimes: cached entries, including stale entries, can register without starting background discovery or catalog HTTP requests.
- Uses `cache.json` in this extension directory and never writes `agent/models.json`.
- Never calls `ModelRegistry.refresh()` because that would clear dynamically registered models.

## Free-model verifier

Use the verifier when you want to audit cached `isFree` classifications without changing provider ownership or writing to `agent/models.json`.

```bash
npm run verify:free-models -- --dry-run
npm run verify:free-models -- --provider openrouter --model openai/gpt-oss-20b --strict
npm run verify:free-models -- --json --no-credentials
```

Flags:

- `--help` prints usage and credential guidance.
- `--dry-run` computes decisions without rewriting `cache.json`.
- `--provider <id>` limits verification to one cached provider ID.
- `--model <id>` limits verification to one model ID across matching providers.
- `--concurrency <n>` sets the positive integer fan-out cap for generation probes.
- `--json` emits one machine-readable result object with summary counts, timing, and cache status.
- `--strict` exits non-zero if any model is unverifiable or no model can be verified.
- `--no-credentials` strips API-key/auth headers from outbound verifier probes.

Result categories are `confirmed-free`, `confirmed-paid`, `downgraded-to-paid`, `upgraded-to-free`, `unverifiable`, and `skipped`. Unverifiable results include actionable operator hints such as checking credentials, provider availability, rate limits, endpoint listings, or unsupported discovery APIs.

By default the CLI sends configured provider credentials with probes so authenticated provider endpoints can be checked. Secrets are never printed to stdout/stderr, JSON output, debug logs, or cache files; use `--no-credentials` for anonymous probes when you only want public endpoint behavior.

The probe strategy is intentionally cautious: the verifier reads `cache.json`, consults supported OpenAI-compatible model-list endpoints and explicit pricing metadata first, skips whole-provider-free or unsupported providers, and only calls `chat/completions` when listing data cannot classify a cached free/paid model. Cache writes only happen for changed classifications, and `--dry-run` reports would-be decisions without updating provenance.

## Development

```bash
npm install
npm run check
npm run package:dry-run
```

`config.schema.json` documents the supported configuration surface. `cache.json`, `config.json`, `debug/`, `dist/`, and `node_modules/` are intentionally excluded from release packaging.

## Compatibility notes

Pi extension discovery uses `fs.readdirSync()` in the local Pi loader without an explicit sort. On common filesystems this is usually alphabetical, but synchronous cache-first registration avoids relying solely on load order. Discovered models that match pi-fast-mode globs are eligible for fast-mode.

## Related Pi Extensions

- [pi-model-profiles](https://github.com/MasuRii/pi-model-profiles) — Whole-agent model frontmatter snapshot management
- [pi-multi-auth](https://github.com/MasuRii/pi-multi-auth) — Multi-provider credential management, OAuth login, and account rotation
- [pi-fast-mode](https://github.com/MasuRii/pi-fast-mode) — Fast-mode toggles and priority service tier injection
- [pi-kiro-provider](https://github.com/MasuRii/pi-kiro-provider) — Kiro streaming AI provider registration

## License

[MIT](LICENSE)
