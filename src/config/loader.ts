import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { getBuiltInProviderProfile, builtInProfileAllowsCredential, listBuiltInProviderProfileIds, type BuiltInCredentialKind, type BuiltInProviderProfile } from "../discovery/builtin-profiles.js";
import { inferCloudflareModelsEndpoint, inferXiaomiModelsEndpoint } from "../discovery/provider-quirks.js";
import { normalizeInput, normalizeOutput } from "../enrichment/defaults.js";
import { isRecord, validateBaseUrl } from "../shared/validation.js";
import { SUPPORTED_DISCOVERY_TYPES } from "./types.js";
import type {
  AutoImportConfig,
  ConfigLoadResult,
  DiscoveryDefaults,
  DiscoveryPaginationConfig,
  DiscoveryType,
  ExtensionConfig,
  ModelDefaults,
  ProviderConfigEntry,
  ProviderDiscoveryConfig,
  RegistrationConfig,
  RegistrationImportMode,
  RegistrationOwnershipConflictMode,
} from "./types.js";
import type { CredentialEntry } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;
const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;
const JSON_READ_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200] as const;
const MAX_PAGINATION_PAGES = 100;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SUPPORTED_AUTO_IMPORT_APIS = new Set(["openai-completions"]);
const SUPPORTED_IMPORT_MODES: readonly RegistrationImportMode[] = ["replace", "merge", "sync"];
/**
 * Static fallback of Pi-Mono-managed built-in provider IDs. Used only when no
 * dynamic `builtinProviderIds` set is supplied to the loader (e.g. the
 * standalone verifier CLI has no model registry). Runtime callers inject the
 * live set from `pi.modelRegistry.getAll()` so this list never has to track
 * upstream renames or additions by hand.
 */
const PI_MONO_BUILTIN_PROVIDER_FALLBACK_IDS = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
]);
const PI_MULTI_AUTH_EXTRA_PROVIDER_IDS = new Set(["cloudflare", "qwen"]);
const PUBLIC_DISCOVERY_API_KEY = "pi-model-discovery-public";

interface LoaderPaths {
  extensionRoot: string;
  configPath?: string;
  modelsJsonPath?: string;
  authJsonPath?: string;
  multiAuthJsonPath?: string;
  /**
   * Pi-Mono-managed built-in provider IDs discovered dynamically at runtime
   * (e.g. from `pi.modelRegistry.getAll()`). When supplied, this replaces the
   * static fallback set so auto-import skip decisions and stale-cache pruning
   * reflect the live built-in catalog instead of a hardcoded list.
   */
  builtinProviderIds?: ReadonlySet<string>;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientJsonReadError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function readJsonFileWithTransientRetry(path: string): unknown {
  let lastError: unknown;
  for (const delayMs of [0, ...JSON_READ_RETRY_DELAYS_MS]) {
    if (delayMs > 0) sleepSync(delayMs);
    try {
      return readJsonFile(path);
    } catch (error) {
      lastError = error;
      if (!isTransientJsonReadError(error)) throw error;
    }
  }
  throw lastError;
}

function resolveAgentDir(extensionRoot: string): string {
  let current = resolve(extensionRoot);
  const { root } = parse(current);
  while (true) {
    if (current === root) break;
    if (existsSync(join(current, "auth.json"))) return current;
    current = dirname(current);
  }
  return resolve(extensionRoot, "..", "..");
}

function resolveAgentJsonPath(extensionRoot: string, fileName: "models.json" | "auth.json" | "multi-auth.json"): string {
  return join(resolveAgentDir(extensionRoot), fileName);
}

/** Validate that {@link value} is a record, pushing a warning and returning undefined otherwise. */
function readOptionalRecord(value: unknown, warnings: string[], label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value)) return value;
  warnings.push(`${label} must be an object; ignoring it.`);
  return undefined;
}

function withOptionalRecord<T>(value: unknown, warnings: string[], label: string, fn: (record: Record<string, unknown>) => T | undefined): T | undefined {
  const record = readOptionalRecord(value, warnings, label);
  return record ? fn(record) : undefined;
}

function toStringRecord(value: unknown, warnings: string[], label: string): Record<string, string> {
  const record = readOptionalRecord(value, warnings, label);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === "string") {
      result[key] = rawValue;
    } else {
      warnings.push(`${label}.${key} must be a string; ignoring it.`);
    }
  }
  return result;
}

function isDiscoveryType(value: unknown): value is DiscoveryType {
  return typeof value === "string" && (SUPPORTED_DISCOVERY_TYPES as readonly string[]).includes(value);
}

function formatSupportedDiscoveryTypes(): string {
  return SUPPORTED_DISCOVERY_TYPES.join(", ");
}

function toDiscoveryTypeRecord(value: unknown, warnings: string[], label: string): Record<string, DiscoveryType> {
  const entries = toStringRecord(value, warnings, label);
  const result: Record<string, DiscoveryType> = {};
  for (const [providerId, type] of Object.entries(entries)) {
    if (isDiscoveryType(type)) {
      result[providerId] = type;
    } else {
      warnings.push(`${label}.${providerId} must be one of ${formatSupportedDiscoveryTypes()}; ignoring it.`);
    }
  }
  return result;
}

const ABSOLUTE_ENDPOINT_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function validateEndpointPath(value: string | undefined, warnings: string[], label: string): { ok: boolean; value?: string } {
  const endpointPath = typeof value === "string" ? value.trim() : "";
  if (!endpointPath) return { ok: true };
  if (!ABSOLUTE_ENDPOINT_PATTERN.test(endpointPath)) return { ok: true, value: endpointPath };

  let parsed: URL;
  try {
    parsed = new URL(endpointPath);
  } catch {
    warnings.push(`${label} endpointPath must be a valid absolute URL.`);
    return { ok: false };
  }
  if (parsed.hash) {
    warnings.push(`${label} endpointPath must not contain fragments.`);
    return { ok: false };
  }

  const validation = validateBaseUrl(`${parsed.origin}${parsed.pathname}`, { allowLocalHttp: true });
  if (!validation.ok || !validation.value) {
    warnings.push(`${label} ${validation.reason ?? "is invalid"}.`);
    return { ok: false };
  }
  return { ok: true, value: parsed.toString() };
}

function toEndpointPathRecord(value: unknown, warnings: string[], label: string): Record<string, string> {
  const entries = toStringRecord(value, warnings, label);
  const result: Record<string, string> = {};
  for (const [providerId, endpointPath] of Object.entries(entries)) {
    const validation = validateEndpointPath(endpointPath, warnings, `${label}.${providerId}`);
    if (validation.ok && validation.value !== undefined) result[providerId] = validation.value;
  }
  return result;
}

function normalizeCatalogUrl(value: unknown, warnings: string[], label: string, fallback: string): string {
  const configured = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const validation = validateBaseUrl(configured, { allowLocalHttp: true });
  if (validation.ok && validation.value) return validation.value;
  warnings.push(`${label} ${validation.reason ?? "is invalid"}; using ${fallback}.`);
  return fallback;
}

function normalizeModelsDevUrl(value: unknown, warnings: string[]): string {
  return normalizeCatalogUrl(value, warnings, "modelsDev.url", DEFAULT_MODELS_DEV_URL);
}

function normalizeOpenRouterUrl(value: unknown, warnings: string[]): string {
  return normalizeCatalogUrl(value, warnings, "openRouter.url", DEFAULT_OPENROUTER_MODELS_URL);
}

function toStringArray(value: unknown, warnings: string[], label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label} must be an array; ignoring it.`);
    return [];
  }
  const normalized: string[] = [];
  for (const entry of value) {
    const valid = typeof entry === "string" && entry.trim().length > 0;
    if (!valid) {
      warnings.push(`${label} contains a non-string entry; ignoring it.`);
      continue;
    }
    normalized.push(entry.trim());
  }
  return Array.from(new Set(normalized));
}

function normalizeHiddenProviderIds(rawHiddenProviders: unknown, warnings: string[], label: string): string[] {
  const hiddenProviders = toStringArray(rawHiddenProviders, warnings, label);
  const normalized: string[] = [];
  for (const providerId of hiddenProviders) {
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      warnings.push(`${label} contains unsafe provider ID '${providerId}'; ignoring it.`);
      continue;
    }
    normalized.push(providerId);
  }
  return Array.from(new Set(normalized));
}

function readHiddenProvidersFromMultiAuthRoot(root: unknown, warnings: string[]): string[] {
  if (!isRecord(root)) return [];
  const ui = isRecord(root.ui) ? root.ui : {};
  const rawHiddenProviders = ui.hiddenProviders ?? ui.hiddenproviders ?? root.hiddenProviders ?? root.hiddenproviders;
  return normalizeHiddenProviderIds(rawHiddenProviders, warnings, "multi-auth.json.ui.hiddenProviders");
}

function loadHiddenProvidersFromMultiAuth(path: string, warnings: string[]): string[] {
  if (!existsSync(path)) return [];
  try {
    return readHiddenProvidersFromMultiAuthRoot(readJsonFileWithTransientRetry(path), warnings);
  } catch (error) {
    if (!isTransientJsonReadError(error)) {
      warnings.push(`Unable to read hidden providers from multi-auth.json: ${error instanceof Error ? error.message : "unknown error"}.`);
    }
    return [];
  }
}

interface HiddenProviderResolution {
  providers?: string[];
  warnings: string[];
}

function loadHiddenProvidersFromMultiAuthConfig(extensionRoot: string): HiddenProviderResolution {
  const warnings: string[] = [];
  const configPath = join(resolveAgentDir(extensionRoot), "extensions", "pi-multi-auth", "config.json");
  if (!existsSync(configPath)) return { warnings };

  try {
    return {
      providers: readHiddenProvidersFromMultiAuthRoot(readJsonFileWithTransientRetry(configPath), warnings),
      warnings,
    };
  } catch (error) {
    if (!isTransientJsonReadError(error)) {
      warnings.push(`Unable to read hidden providers from pi-multi-auth config.json: ${error instanceof Error ? error.message : "unknown error"}. Falling back to legacy hidden-provider JSON import.`);
    }
    return { warnings };
  }
}

function collectExternalStaticProviderId(
  provider: Record<string, unknown>,
  fallbackProviderId: string | undefined,
  warnings: string[],
  label: string,
): string | undefined {
  if (provider.enabled === false) return undefined;
  if (!Array.isArray(provider.models) || provider.models.length === 0) return undefined;
  const providerId = typeof provider.providerId === "string" && provider.providerId.trim()
    ? provider.providerId.trim()
    : typeof provider.id === "string" && provider.id.trim()
      ? provider.id.trim()
      : fallbackProviderId;
  if (!providerId) return undefined;
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    warnings.push(`${label} declares unsafe static provider ID '${providerId}'; ignoring it.`);
    return undefined;
  }
  return providerId;
}

function readExternalStaticProviderIdsFromExtensionConfigRoot(root: unknown, warnings: string[], label: string): string[] {
  if (!isRecord(root)) return [];
  const providerIds: string[] = [];
  const rootProviderId = collectExternalStaticProviderId(root, undefined, warnings, label);
  if (rootProviderId) providerIds.push(rootProviderId);

  if (Array.isArray(root.providers)) {
    root.providers.forEach((provider, index) => {
      if (!isRecord(provider)) return;
      const providerId = collectExternalStaticProviderId(provider, undefined, warnings, `${label}.providers[${index}]`);
      if (providerId) providerIds.push(providerId);
    });
  } else if (isRecord(root.providers)) {
    for (const [providerId, provider] of Object.entries(root.providers)) {
      if (!isRecord(provider)) continue;
      const collectedProviderId = collectExternalStaticProviderId(provider, providerId, warnings, `${label}.providers.${providerId}`);
      if (collectedProviderId) providerIds.push(collectedProviderId);
    }
  }

  return Array.from(new Set(providerIds));
}

function loadExternalStaticProviderIdsFromExtensions(extensionRoot: string, warnings: string[]): string[] {
  const extensionsDir = join(resolveAgentDir(extensionRoot), "extensions");
  if (!existsSync(extensionsDir)) return [];
  const providerIds: string[] = [];
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extensionConfigPath = join(extensionsDir, entry.name, "config.json");
    if (!existsSync(extensionConfigPath)) continue;
    try {
      providerIds.push(
        ...readExternalStaticProviderIdsFromExtensionConfigRoot(readJsonFile(extensionConfigPath), warnings, `${entry.name}/config.json`),
      );
    } catch (error) {
      warnings.push(`Unable to inspect ${entry.name}/config.json for external static providers: ${error instanceof Error ? error.message : "unknown error"}.`);
    }
  }
  return Array.from(new Set(providerIds));
}

function toPositiveInteger(value: unknown, warnings: string[], label: string): number | undefined;
function toPositiveInteger(value: unknown, warnings: string[], label: string, fallback: number): number;
function toPositiveInteger(value: unknown, warnings: string[], label: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  warnings.push(`${label} must be a positive integer; ${fallback === undefined ? "ignoring it" : `using ${fallback}`}.`);
  return fallback;
}

function resolveEnvValue(value: string | undefined, warnings: string[], label: string): string | undefined {
  if (value === undefined) return undefined;
  const match = ENV_REF_PATTERN.exec(value.trim());
  if (!match) return value;
  const envName = match[1]!;
  const resolved = process.env[envName];
  if (!resolved) {
    warnings.push(`${label} references unset environment variable ${envName}; skipping provider.`);
    return undefined;
  }
  return resolved;
}

function resolveEnvRecord(record: Record<string, string>, warnings: string[], label: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const resolved = resolveEnvValue(value, warnings, `${label}.${key}`);
    if (resolved === undefined) return undefined;
    result[key] = resolved;
  }
  return result;
}

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function normalizeCapabilities(value: unknown, warnings: string[], label: string): DiscoveryDefaults["capabilities"] | undefined {
  return withOptionalRecord(value, warnings, label, (record) => {
    const normalized: NonNullable<DiscoveryDefaults["capabilities"]> = {};
    for (const [key, rawValue] of Object.entries(record)) {
      if (typeof rawValue === "boolean") normalized[key] = rawValue;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  });
}

function normalizeThinkingLevelMap(
  value: unknown,
  warnings: string[],
  label: string,
): DiscoveryDefaults["thinkingLevelMap"] | undefined {
  return withOptionalRecord(value, warnings, label, (record) => {
    const normalized: NonNullable<DiscoveryDefaults["thinkingLevelMap"]> = {};
    let hasEntries = false;

    for (const key of THINKING_LEVEL_KEYS) {
      const mapped = record[key];
      if (typeof mapped === "string" || mapped === null) {
        normalized[key] = mapped;
        hasEntries = true;
      }
    }

    return hasEntries ? normalized : undefined;
  });
}

function normalizeDefaults(value: unknown, warnings: string[], label: string): DiscoveryDefaults {
  const record = readOptionalRecord(value, warnings, label);
  if (!record) return {};

  const defaults: DiscoveryDefaults = {};
  if (typeof record.baseUrl === "string" && record.baseUrl.trim()) defaults.baseUrl = record.baseUrl.trim();
  if (typeof record.reasoning === "boolean") defaults.reasoning = record.reasoning;
  const thinkingLevelMap = normalizeThinkingLevelMap(record.thinkingLevelMap, warnings, `${label}.thinkingLevelMap`);
  if (thinkingLevelMap) defaults.thinkingLevelMap = thinkingLevelMap;
  const input = normalizeInput(record.input);
  if (input) defaults.input = input;
  const output = normalizeOutput(record.output);
  if (output) defaults.output = output;
  const capabilities = normalizeCapabilities(record.capabilities, warnings, `${label}.capabilities`);
  if (capabilities) defaults.capabilities = capabilities;
  if (isRecord(record.cost)) {
    defaults.cost = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const costValue = record.cost[key];
      if (typeof costValue === "number" && Number.isFinite(costValue)) defaults.cost[key] = costValue;
    }
  }
  if (typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow)) defaults.contextWindow = record.contextWindow;
  if (typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens)) defaults.maxTokens = record.maxTokens;
  if (isRecord(record.compat)) defaults.compat = record.compat as DiscoveryDefaults["compat"];
  return defaults;
}

function normalizeModelDefaults(value: unknown, warnings: string[], label: string): ModelDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const defaults: ModelDefaults = normalizeDefaults(value, warnings, label);
  if (typeof value.name === "string" && value.name.trim()) defaults.name = value.name.trim();
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function readProviderIdsFromModelsRoot(modelsRoot: unknown): Set<string> {
  if (!isRecord(modelsRoot) || !isRecord(modelsRoot.providers)) return new Set();
  return new Set(Object.keys(modelsRoot.providers));
}

function readProviderIdsFromAuthRoot(authRoot: unknown): Set<string> {
  if (!isRecord(authRoot)) return new Set();
  return new Set(Object.keys(authRoot));
}

function loadExistingProviderIds(modelsJsonPath: string, warnings: string[]): Set<string> {
  if (!existsSync(modelsJsonPath)) return new Set();
  try {
    return readProviderIdsFromModelsRoot(readJsonFile(modelsJsonPath));
  } catch (error) {
    warnings.push(`Unable to read existing provider IDs from models.json: ${error instanceof Error ? error.message : "unknown error"}.`);
    return new Set();
  }
}

function resolvePiMultiAuthManagedProviderIds(builtinProviderIds: ReadonlySet<string>, modelsRoot: unknown, authRoot: unknown, existingProviderIds: ReadonlySet<string>): Set<string> {
  return new Set([
    ...resolveMultiAuthManagedProviderIds(builtinProviderIds),
    ...existingProviderIds,
    ...readProviderIdsFromModelsRoot(modelsRoot),
    ...readProviderIdsFromAuthRoot(authRoot),
  ]);
}

function normalizeDiscoveryPagination(value: unknown, warnings: string[], label: string): DiscoveryPaginationConfig | undefined {
  const record = readOptionalRecord(value, warnings, label);
  if (!record) return undefined;
  if (record.enabled === false) return undefined;

  const cursorParam = typeof record.cursorParam === "string" && record.cursorParam.trim() ? record.cursorParam.trim() : "after";
  const nextCursorField = typeof record.nextCursorField === "string" && record.nextCursorField.trim() ? record.nextCursorField.trim() : "next_page";
  const hasMoreField = typeof record.hasMoreField === "string" && record.hasMoreField.trim() ? record.hasMoreField.trim() : "has_more";
  const requestedMaxPages = record.maxPages === undefined ? undefined : toPositiveInteger(record.maxPages, warnings, `${label}.maxPages`, MAX_PAGINATION_PAGES);
  const maxPages = requestedMaxPages !== undefined && requestedMaxPages > MAX_PAGINATION_PAGES ? MAX_PAGINATION_PAGES : requestedMaxPages;
  if (requestedMaxPages !== undefined && requestedMaxPages > MAX_PAGINATION_PAGES) {
    warnings.push(`${label}.maxPages must be ${MAX_PAGINATION_PAGES} or lower; using ${MAX_PAGINATION_PAGES}.`);
  }

  return {
    enabled: true,
    cursorParam,
    nextCursorField,
    hasMoreField,
    maxPages,
  };
}

function normalizeProviderDiscovery(
  rawProvider: Record<string, unknown>,
  providerId: string,
  label: string,
  defaultCacheTtl: number,
  warnings: string[],
): ProviderDiscoveryConfig | undefined {
  const discoveryRaw = isRecord(rawProvider.discovery) ? rawProvider.discovery : {};
  const discoveryType = isDiscoveryType(discoveryRaw.type) ? discoveryRaw.type : undefined;
  if (!discoveryType) {
    warnings.push(`${label}.discovery.type must be one of ${formatSupportedDiscoveryTypes()}; skipping provider ${providerId}.`);
    return undefined;
  }
  const discoveryHeaders = resolveEnvRecord(toStringRecord(discoveryRaw.headers, warnings, `${label}.discovery.headers`), warnings, `${label}.discovery.headers`);
  if (!discoveryHeaders) return undefined;
  const endpointPath = validateEndpointPath(typeof discoveryRaw.endpointPath === "string" ? discoveryRaw.endpointPath : undefined, warnings, `${label}.discovery.endpointPath`);
  if (!endpointPath.ok) {
    warnings.push(`${label}.discovery.endpointPath is unsafe; skipping provider ${providerId}.`);
    return undefined;
  }

  return {
    type: discoveryType,
    enabled: discoveryRaw.enabled !== false,
    endpointPath: endpointPath.value,
    headers: discoveryHeaders,
    timeoutMs: toPositiveInteger(discoveryRaw.timeoutMs, warnings, `${label}.discovery.timeoutMs`, DEFAULT_TIMEOUT_MS),
    ttlMs: discoveryRaw.ttlMs === undefined ? defaultCacheTtl : toPositiveInteger(discoveryRaw.ttlMs, warnings, `${label}.discovery.ttlMs`, defaultCacheTtl),
    includeDetails: discoveryRaw.includeDetails === true,
    allowModels: toStringArray(discoveryRaw.allowModels, warnings, `${label}.discovery.allowModels`),
    blockModels: toStringArray(discoveryRaw.blockModels, warnings, `${label}.discovery.blockModels`),
    pagination: normalizeDiscoveryPagination(discoveryRaw.pagination, warnings, `${label}.discovery.pagination`),
  } satisfies ProviderDiscoveryConfig;
}

function normalizeBaseUrl(rawBaseUrl: unknown, warnings: string[], label: string, providerId: string, allowPrivateHttp = false): string | undefined {
  const baseUrl = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : "";
  if (!baseUrl) {
    warnings.push(`${label}.baseUrl is required; skipping provider ${providerId}.`);
    return undefined;
  }
  const validation = validateBaseUrl(baseUrl, { allowLocalHttp: true, allowPrivateHttp });
  if (!validation.ok || !validation.value) {
    warnings.push(`${label}.baseUrl ${validation.reason ?? "is invalid"}; skipping provider ${providerId}.`);
    return undefined;
  }
  return validation.value;
}

function readExplicitModelDefaults(value: unknown, warnings: string[], label: string): Record<string, ModelDefaults> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    warnings.push(`${label} must be an object keyed by model ID; ignoring it.`);
    return {};
  }
  const defaults: Record<string, ModelDefaults> = {};
  for (const [modelId, rawDefaults] of Object.entries(value)) {
    if (!modelId.trim()) {
      warnings.push(`${label} contains an empty model ID; ignoring it.`);
      continue;
    }
    const normalized = normalizeModelDefaults(rawDefaults, warnings, `${label}.${modelId}`);
    if (normalized) defaults[modelId] = normalized;
  }
  return defaults;
}

function normalizeProvider(
  rawProvider: unknown,
  index: number,
  globalMaxModels: number | undefined,
  defaultCacheTtl: number,
  existingProviderIds: ReadonlySet<string>,
  warnings: string[],
): ProviderConfigEntry | undefined {
  const label = `providers[${index}]`;
  if (!isRecord(rawProvider)) {
    warnings.push(`${label} must be an object; skipping it.`);
    return undefined;
  }

  const id = typeof rawProvider.id === "string" ? rawProvider.id.trim() : "";
  if (!PROVIDER_ID_PATTERN.test(id)) {
    warnings.push(`${label}.id must match ${PROVIDER_ID_PATTERN.source}; skipping provider.`);
    return undefined;
  }
  if (existingProviderIds.has(id)) {
    warnings.push(`Provider ID '${id}' matches agent/models.json; existing credential extensions may manage that provider.`);
  }

  const baseUrl = normalizeBaseUrl(rawProvider.baseUrl, warnings, label, id, rawProvider.allowPrivateHttp === true);
  if (!baseUrl) return undefined;

  const api = typeof rawProvider.api === "string" ? rawProvider.api : "";
  if (!api) {
    warnings.push(`${label}.api is required; skipping provider ${id}.`);
    return undefined;
  }

  const authHeader = rawProvider.authHeader !== false;
  const apiKey = resolveEnvValue(typeof rawProvider.apiKey === "string" ? rawProvider.apiKey : undefined, warnings, `${label}.apiKey`);
  if (!apiKey && authHeader) {
    warnings.push(`${label}.apiKey is required for scoped-model auth; skipping provider ${id}.`);
    return undefined;
  }

  const headers = resolveEnvRecord(toStringRecord(rawProvider.headers, warnings, `${label}.headers`), warnings, `${label}.headers`);
  if (!headers) return undefined;

  const discovery = normalizeProviderDiscovery(rawProvider, id, label, defaultCacheTtl, warnings);
  if (!discovery) return undefined;

  return {
    id,
    baseUrl,
    apiKey: apiKey ?? PUBLIC_DISCOVERY_API_KEY,
    api: api as ProviderConfigEntry["api"],
    authHeader,
    headers,
    maxModels: rawProvider.maxModels === undefined ? globalMaxModels : toPositiveInteger(rawProvider.maxModels, warnings, `${label}.maxModels`),
    discovery,
    defaults: normalizeDefaults(rawProvider.defaults, warnings, `${label}.defaults`),
    modelDefaults: readExplicitModelDefaults(rawProvider.modelDefaults, warnings, `${label}.modelDefaults`),
    fallbackModelIds: toStringArray(rawProvider.fallbackModelIds, warnings, `${label}.fallbackModelIds`),
    source: "explicit",
  };
}

function resolveConfigPath(value: unknown, configDir: string, fallback: string): string {
  return typeof value === "string" && value.trim() ? resolve(configDir, value) : fallback;
}

function normalizeAutoImport(
  rawAutoImport: unknown,
  configDir: string,
  defaultModelsJsonPath: string,
  defaultAuthJsonPath: string,
  multiAuthJsonPath: string,
  hiddenProviders: string[],
  externalStaticProviderIds: string[],
  defaultCacheTtl: number,
  warnings: string[],
): AutoImportConfig {
  const raw = isRecord(rawAutoImport) ? rawAutoImport : {};
  const discoveryRaw = isRecord(raw.discovery) ? raw.discovery : {};
  return {
    enabled: raw.enabled !== false,
    allowUnauthenticated: raw.allowUnauthenticated === true,
    modelsJsonPath: resolveConfigPath(raw.modelsJsonPath, configDir, defaultModelsJsonPath),
    authJsonPath: resolveConfigPath(raw.authJsonPath, configDir, defaultAuthJsonPath),
    multiAuthJsonPath,
    includeProviders: toStringArray(raw.includeProviders, warnings, "autoImport.includeProviders"),
    excludeProviders: toStringArray(raw.excludeProviders, warnings, "autoImport.excludeProviders"),
    hiddenProviders,
    externalStaticProviderIds,
    discovery: {
      enabled: discoveryRaw.enabled !== false,
      headers: toStringRecord(discoveryRaw.headers, warnings, "autoImport.discovery.headers"),
      timeoutMs: toPositiveInteger(discoveryRaw.timeoutMs, warnings, "autoImport.discovery.timeoutMs", DEFAULT_TIMEOUT_MS),
      ttlMs: discoveryRaw.ttlMs === undefined ? defaultCacheTtl : toPositiveInteger(discoveryRaw.ttlMs, warnings, "autoImport.discovery.ttlMs", defaultCacheTtl),
      includeDetails: discoveryRaw.includeDetails === true,
      typeByProvider: toDiscoveryTypeRecord(discoveryRaw.typeByProvider, warnings, "autoImport.discovery.typeByProvider"),
      endpointPathByProvider: toEndpointPathRecord(discoveryRaw.endpointPathByProvider, warnings, "autoImport.discovery.endpointPathByProvider"),
    },
  };
}

function readOptionalJson(path: string, warnings: string[], label: string): unknown | undefined {
  if (!existsSync(path)) {
    warnings.push(`Auto-import ${label} not found; no providers imported from ${label}.`);
    return undefined;
  }
  try {
    return readJsonFile(path);
  } catch (error) {
    warnings.push(`Auto-import could not read ${label}: ${error instanceof Error ? error.message : "unknown error"}.`);
    return undefined;
  }
}

function normalizeAutoImportedBaseUrl(baseUrl: string, providerId: string, warnings: string[]): string | undefined {
  const validation = validateBaseUrl(baseUrl, { allowLocalHttp: true });
  if (!validation.ok || !validation.value) {
    warnings.push(`Auto-import skipped provider '${providerId}': ${validation.reason ?? "baseUrl is invalid"}.`);
    return undefined;
  }
  return validation.value;
}

function inferAutoDiscoveryType(
  providerId: string,
  provider: Record<string, unknown>,
  autoImport: AutoImportConfig,
  profile?: BuiltInProviderProfile,
): DiscoveryType | undefined {
  const configuredType = autoImport.discovery.typeByProvider[providerId];
  if (configuredType) return configuredType;
  const api = typeof provider.api === "string" ? provider.api : "";
  if (SUPPORTED_AUTO_IMPORT_APIS.has(api)) return "openai-compat";
  return profile?.discoveryType;
}

function inferAutoEndpointPath(
  providerId: string,
  effectiveBaseUrl: string,
  autoImport: AutoImportConfig,
  profile?: BuiltInProviderProfile,
): string | undefined {
  const configuredEndpoint = autoImport.discovery.endpointPathByProvider[providerId] ?? (profile ? autoImport.discovery.endpointPathByProvider[profile.id] : undefined);
  if (configuredEndpoint) return configuredEndpoint;
  if (profile?.endpointPath) return profile.endpointPath;
  const profileId = profile?.id ?? providerId;
  if (profileId === "cline") return "https://openrouter.ai/api/v1/models";
  if (profileId === "cloudflare") return inferCloudflareModelsEndpoint(effectiveBaseUrl);
  if (profileId === "xiaomi" || profileId.startsWith("xiaomi-token-plan-")) return inferXiaomiModelsEndpoint(effectiveBaseUrl);
  return undefined;
}

function inferProfileBaseUrl(profile: BuiltInProviderProfile | undefined): string | undefined {
  return profile?.baseUrl;
}

function readFallbackModelIds(rawModels: unknown): string[] {
  if (!Array.isArray(rawModels)) return [];
  const ids = rawModels
    .filter((rawModel): rawModel is Record<string, unknown> => isRecord(rawModel) && typeof rawModel.id === "string" && rawModel.id.length > 0)
    .map((rawModel) => rawModel.id as string);
  return Array.from(new Set(ids));
}

interface AutoImportCredential {
  apiKey: string;
  kind: BuiltInCredentialKind | "public";
  authHeader: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
}

function resolveImportedSecretValue(value: unknown, warnings: string[], label: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const resolved = resolveEnvValue(value.trim(), warnings, label);
  if (resolved === undefined) return undefined;
  if (resolved.startsWith("!")) {
    warnings.push(`${label} uses shell command resolution, which pi-model-discovery does not execute; ignoring it.`);
    return undefined;
  }
  return process.env[resolved] || resolved;
}

function readAuthCredential(
  authRoot: unknown,
  providerId: string,
  warnings: string[],
): { apiKey?: string; kind?: BuiltInCredentialKind; reason?: string } {
  if (!isRecord(authRoot)) return { reason: "auth file is not an object" };
  const credential = authRoot[providerId];
  if (credential === undefined) return { reason: "missing API-key credential" };
  if (!isRecord(credential)) return { reason: "credential is not an API-key record" };
  if (credential.type !== "api_key" && credential.type !== "oauth") return { reason: "credential is not API-key based" };
  const kind = credential.type;
  const secretField = kind === "oauth" && credential.key === undefined ? "access" : "key";
  const apiKey = resolveImportedSecretValue(credential[secretField], warnings, `auth.json.${providerId}.${secretField}`);
  if (!apiKey) return { reason: `${kind === "oauth" ? "OAuth" : "API-key"} credential is empty` };
  return { apiKey, kind };
}

function sanitizeImportedHeaders(headers: Record<string, string>, warnings: string[], label: string): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (["authorization", "proxy-authorization", "x-api-key", "api-key", "x-auth-token"].includes(normalizedKey)) {
      warnings.push(`${label}.${key} is managed from credential material and was ignored.`);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Resolve the full credential pool available to a provider for rotation. Walks
 * every ordered candidate id, resolves its API-key credential, and deduplicates
 * by key value. The primary credential (the one already selected for
 * `provider.apiKey`) is always first; remaining distinct keys follow in candidate
 * order so a verifier can rotate on retryable failures. Public/anonymous and
 * OAuth credentials are excluded (OAuth is not approved for verifier probes).
 * Returns `undefined` when only the primary key is available, so single-key
 * providers pay no pool overhead.
 */
function resolveCredentialPool(
  authRoot: unknown,
  orderedCredentialProviderIds: readonly string[],
  autoImport: AutoImportConfig,
  profile: BuiltInProviderProfile | undefined,
  primary: AutoImportCredential,
): CredentialEntry[] | undefined {
  if (primary.kind === "public" || primary.kind === "oauth") return undefined;
  const pool: CredentialEntry[] = [];
  const seen = new Set<string>();
  const add = (credential: AutoImportCredential, sourceId: string): void => {
    if (credential.kind !== "api_key") return;
    if (seen.has(credential.apiKey)) return;
    seen.add(credential.apiKey);
    pool.push({ apiKey: credential.apiKey, authHeader: credential.authHeader, headers: credential.headers, sourceId });
  };
  add(primary, orderedCredentialProviderIds[0] ?? "");
  for (const candidateId of orderedCredentialProviderIds) {
    const localWarnings: string[] = [];
    const credential = resolveAutoImportCredential(authRoot, candidateId, { autoImport, profile, warnings: localWarnings, options: { requireAuthJsonCredential: false } });
    if (credential) add(credential, candidateId);
  }
  return pool.length > 1 ? pool : undefined;
}

function readCredentialRequestOverrides(authRoot: unknown, providerId: string, warnings: string[]): Pick<AutoImportCredential, "baseUrl" | "headers"> {
  if (!isRecord(authRoot)) return {};
  const credential = authRoot[providerId];
  if (!isRecord(credential) || !isRecord(credential.request)) return {};
  const overrides: Pick<AutoImportCredential, "baseUrl" | "headers"> = {};

  if (typeof credential.request.baseUrl === "string" && credential.request.baseUrl.trim()) {
    const baseUrl = credential.request.baseUrl.trim();
    const validation = validateBaseUrl(baseUrl, { allowLocalHttp: true });
    if (validation.ok && validation.value) {
      overrides.baseUrl = validation.value;
    } else {
      warnings.push(`Auto-import ignored provider '${providerId}' auth.json request.baseUrl because ${validation.reason ?? "it is invalid"}.`);
    }
  }

  const headers = sanitizeImportedHeaders(
    toStringRecord(credential.request.headers, warnings, `auth.json.${providerId}.request.headers`),
    warnings,
    `auth.json.${providerId}.request.headers`,
  );
  if (Object.keys(headers).length > 0) overrides.headers = headers;
  return overrides;
}

interface AutoImportCredentialContext {
  autoImport: AutoImportConfig;
  profile: BuiltInProviderProfile | undefined;
  warnings: string[];
  options: { requireAuthJsonCredential: boolean };
}

function resolveAutoImportCredential(
  authRoot: unknown,
  providerId: string,
  context: AutoImportCredentialContext,
): AutoImportCredential | undefined {
  const { autoImport, profile, warnings, options } = context;
  const requestOverrides = readCredentialRequestOverrides(authRoot, providerId, warnings);
  const authCredential = readAuthCredential(authRoot, providerId, warnings);
  const envCredential = readProfileEnvCredential(profile);
  if (envCredential) return { apiKey: envCredential, kind: "api_key", authHeader: true, ...requestOverrides };
  if (authCredential.apiKey && authCredential.kind) {
    if (builtInProfileAllowsCredential(profile, authCredential.kind) || authCredential.kind === "api_key") {
      return { apiKey: authCredential.apiKey, kind: authCredential.kind, authHeader: true, ...requestOverrides };
    }
    warnings.push(
      `Auto-import skipped provider '${providerId}': OAuth credential is not approved for read-only model discovery; credential is not API-key based.`,
    );
    return undefined;
  }

  if (profile?.discoveryType === "static") {
    warnings.push(`Auto-import skipped provider '${providerId}': ${authCredential.reason}; static built-in catalogs require an auth.json credential.`);
    return undefined;
  }

  if (options.requireAuthJsonCredential) {
    if (!autoImport.allowUnauthenticated) {
      warnings.push(`Auto-import skipped provider '${providerId}': ${authCredential.reason}; models.json metadata requires an auth.json credential for discovery.`);
    }
    return undefined;
  }

  if (autoImport.allowUnauthenticated) {
    warnings.push(`Auto-import provider '${providerId}' has no API-key credential; attempting unauthenticated discovery.`);
    return { apiKey: PUBLIC_DISCOVERY_API_KEY, kind: "public", authHeader: false, ...requestOverrides };
  }

  warnings.push(`Auto-import skipped provider '${providerId}': ${authCredential.reason}.`);
  return undefined;
}

function readModelDefaults(rawModels: unknown, warnings: string[], providerId: string): Record<string, ModelDefaults> {
  if (rawModels === undefined) return {};
  if (!Array.isArray(rawModels)) {
    warnings.push(`Auto-import provider '${providerId}' models must be an array; model defaults ignored.`);
    return {};
  }
  const defaults: Record<string, ModelDefaults> = {};
  rawModels.forEach((rawModel, index) => {
    if (!isRecord(rawModel) || typeof rawModel.id !== "string" || !rawModel.id) return;
    const modelDefaults = normalizeModelDefaults(rawModel, warnings, `autoImport.providers.${providerId}.models[${index}]`);
    if (modelDefaults) defaults[rawModel.id] = modelDefaults;
  });
  return defaults;
}

function isProviderIdInList(providerId: string, providerIds: readonly string[]): boolean {
  if (providerIds.includes(providerId)) return true;
  const baseProviderId = readNumberedProviderAliasBase(providerId);
  return baseProviderId !== undefined && providerIds.includes(baseProviderId);
}

function isSkippedProviderId(providerId: string, autoImport: AutoImportConfig): boolean {
  return isProviderIdInList(providerId, autoImport.hiddenProviders) || isProviderIdInList(providerId, autoImport.externalStaticProviderIds);
}

function shouldAutoImportProviderCandidate(providerId: string, canonicalProviderId: string, autoImport: AutoImportConfig): boolean {
  if (isSkippedProviderId(providerId, autoImport) || isSkippedProviderId(canonicalProviderId, autoImport)) return false;
  if (autoImport.includeProviders.length > 0 && !autoImport.includeProviders.includes(providerId) && !autoImport.includeProviders.includes(canonicalProviderId)) {
    return false;
  }
  return !autoImport.excludeProviders.includes(providerId) && !autoImport.excludeProviders.includes(canonicalProviderId);
}

function readModelsProviderEntries(modelsRoot: unknown, warnings: string[]): Record<string, unknown> {
  if (modelsRoot === undefined) return {};
  if (!isRecord(modelsRoot) || !isRecord(modelsRoot.providers)) {
    warnings.push("Auto-import models.json does not contain a providers object; falling back to auth.json built-in profiles only.");
    return {};
  }
  return modelsRoot.providers;
}

function readAuthCredentialKind(authRoot: unknown, providerId: string): BuiltInCredentialKind | undefined {
  if (!isRecord(authRoot)) return undefined;
  const credential = authRoot[providerId];
  if (!isRecord(credential)) return undefined;
  return credential.type === "api_key" || credential.type === "oauth" ? credential.type : undefined;
}

function readProfileEnvCredential(profile: BuiltInProviderProfile | undefined): string | undefined {
  for (const envVar of profile?.credentialEnvVars ?? []) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return undefined;
}

function filterBuiltInProfileIds(predicate: (profile: BuiltInProviderProfile | undefined, providerId: string) => boolean): Set<string> {
  const providerIds = new Set<string>();
  for (const providerId of listBuiltInProviderProfileIds()) {
    if (predicate(getBuiltInProviderProfile(providerId), providerId)) providerIds.add(providerId);
  }
  return providerIds;
}

function readProviderIdsFromProfileEnv(): Set<string> {
  return filterBuiltInProfileIds((profile) => Boolean(readProfileEnvCredential(profile)));
}

function readPublicProfileProviderIds(): Set<string> {
  return filterBuiltInProfileIds((profile) => profile?.supportsPublicDiscovery === true);
}

function builtInProfileAllowsAutoImportCredential(profile: BuiltInProviderProfile | undefined, credentialKind: BuiltInCredentialKind | "public"): boolean {
  if (!profile) return false;
  if (credentialKind === "public") return profile.supportsPublicDiscovery === true;
  return builtInProfileAllowsCredential(profile, credentialKind);
}

function warnUnsupportedAuthOnlyProvider(providerId: string, credentialKind: BuiltInCredentialKind | undefined, warnings: string[]): void {
  if (credentialKind === "oauth") {
    warnings.push(`Auto-import skipped provider '${providerId}': OAuth credential is not approved for read-only model discovery; no built-in provider profile.`);
    return;
  }
  warnings.push(`Auto-import skipped provider '${providerId}': no built-in provider profile supports read-only model discovery.`);
}

function readNumberedProviderAliasBase(providerId: string): string | undefined {
  const match = providerId.match(/^(.*)-\d+$/);
  const baseProviderId = match?.[1];
  return baseProviderId && PROVIDER_ID_PATTERN.test(baseProviderId) ? baseProviderId : undefined;
}

function resolveAutoImportMetadataProviderId(providerId: string, modelProviderEntries: Record<string, unknown>): string {
  if (modelProviderEntries[providerId] !== undefined || getBuiltInProviderProfile(providerId)) return providerId;
  const baseProviderId = readNumberedProviderAliasBase(providerId);
  if (!baseProviderId) return providerId;
  if (modelProviderEntries[baseProviderId] !== undefined || getBuiltInProviderProfile(baseProviderId)) return baseProviderId;
  return providerId;
}

function resolveAutoImportCanonicalProviderId(providerId: string, modelProviderEntries: Record<string, unknown>): string {
  const metadataProviderId = resolveAutoImportMetadataProviderId(providerId, modelProviderEntries);
  if (metadataProviderId !== providerId) return metadataProviderId;
  return readNumberedProviderAliasBase(providerId) ?? providerId;
}

interface AutoImportProviderGroup {
  providerId: string;
  credentialProviderIds: string[];
}

function groupAutoImportProviderCandidates(
  candidateProviderIds: Iterable<string>,
  modelProviderEntries: Record<string, unknown>,
  autoImport: AutoImportConfig,
  warnings: string[],
): AutoImportProviderGroup[] {
  const groups = new Map<string, AutoImportProviderGroup>();
  for (const candidateProviderId of candidateProviderIds) {
    if (!PROVIDER_ID_PATTERN.test(candidateProviderId)) {
      warnings.push(`Auto-import skipped provider '${candidateProviderId}': provider ID is unsafe.`);
      continue;
    }
    const canonicalProviderId = resolveAutoImportCanonicalProviderId(candidateProviderId, modelProviderEntries);
    if (!shouldAutoImportProviderCandidate(candidateProviderId, canonicalProviderId, autoImport)) continue;

    let group = groups.get(canonicalProviderId);
    if (!group) {
      group = { providerId: canonicalProviderId, credentialProviderIds: [] };
      groups.set(canonicalProviderId, group);
    }
    if (!group.credentialProviderIds.includes(candidateProviderId)) group.credentialProviderIds.push(candidateProviderId);
  }
  return [...groups.values()];
}

function readFirstAuthCredentialKind(authRoot: unknown, providerIds: readonly string[]): BuiltInCredentialKind | undefined {
  for (const providerId of providerIds) {
    const kind = readAuthCredentialKind(authRoot, providerId);
    if (kind) return kind;
  }
  return undefined;
}

function hasAuthCredential(authRoot: unknown, providerId: string): boolean {
  return readAuthCredential(authRoot, providerId, []).apiKey !== undefined;
}

function credentialHasRequestBaseUrl(authRoot: unknown, providerId: string): boolean {
  if (!isRecord(authRoot)) return false;
  const credential = authRoot[providerId];
  return isRecord(credential) && isRecord(credential.request) && typeof credential.request.baseUrl === "string" && credential.request.baseUrl.trim().length > 0;
}

function orderCredentialProviderIds(
  providerId: string,
  credentialProviderIds: readonly string[],
  authRoot: unknown,
  provider: Record<string, unknown>,
  profile: BuiltInProviderProfile | undefined,
): string[] {
  const unique = Array.from(new Set([providerId, ...credentialProviderIds]));
  const authBacked = unique.filter((candidateProviderId) => hasAuthCredential(authRoot, candidateProviderId));
  const candidates = authBacked.length > 0 ? authBacked : [providerId];
  const providerBaseUrl = typeof provider.baseUrl === "string" && provider.baseUrl.trim().length > 0 ? provider.baseUrl.trim() : undefined;
  const needsCredentialBaseUrl = !providerBaseUrl && !inferProfileBaseUrl(profile);

  return [...candidates].sort((left, right) => {
    if (needsCredentialBaseUrl) {
      const requestBaseUrlRank = Number(credentialHasRequestBaseUrl(authRoot, right)) - Number(credentialHasRequestBaseUrl(authRoot, left));
      if (requestBaseUrlRank !== 0) return requestBaseUrlRank;
    }
    if (left === providerId) return -1;
    if (right === providerId) return 1;
    return 0;
  });
}

function resolveAutoImportCredentialFromCandidates(
  authRoot: unknown,
  providerId: string,
  credentialProviderIds: readonly string[],
  context: AutoImportCredentialContext,
): AutoImportCredential | undefined {
  const { autoImport, profile, options, warnings } = context;
  let firstFailureWarnings: string[] = [];
  for (const credentialProviderId of credentialProviderIds) {
    const localWarnings: string[] = [];
    const credential = resolveAutoImportCredential(authRoot, credentialProviderId, { autoImport, profile, warnings: localWarnings, options });
    if (credential) {
      warnings.push(...localWarnings);
      return credential;
    }
    if (firstFailureWarnings.length === 0) firstFailureWarnings = localWarnings;
  }
  warnings.push(...firstFailureWarnings.map((warning) => warning.replace(/provider '[^']+'/u, `provider '${providerId}'`)));
  return undefined;
}

function loadAutoImportedProviders(autoImport: AutoImportConfig, globalMaxModels: number | undefined, authRoot: unknown, modelsRoot: unknown, builtinProviderIds: ReadonlySet<string>, warnings: string[]): ProviderConfigEntry[] {
  if (!autoImport.enabled) return [];
  const modelProviderEntries = readModelsProviderEntries(modelsRoot, warnings);
  const candidateProviderIds = new Set([
    ...Object.keys(modelProviderEntries),
    ...readProviderIdsFromAuthRoot(authRoot),
    ...readProviderIdsFromProfileEnv(),
    ...(autoImport.allowUnauthenticated && autoImport.includeProviders.length > 0 ? readPublicProfileProviderIds() : []),
  ]);
  const candidateGroups = groupAutoImportProviderCandidates(candidateProviderIds, modelProviderEntries, autoImport, warnings);

  const providers: ProviderConfigEntry[] = [];
  for (const group of candidateGroups) {
    const providerId = group.providerId;
    if (builtinProviderIds.has(providerId) && readFirstAuthCredentialKind(authRoot, group.credentialProviderIds)) {
      warnings.push(`Auto-import skipped provider '${providerId}': user credential is managed by Pi Mono; pi-model-discovery will not duplicate ownership.`);
      continue;
    }

    const metadataProviderId = resolveAutoImportMetadataProviderId(providerId, modelProviderEntries);
    const inheritedFromProviderId = metadataProviderId !== providerId ? metadataProviderId : undefined;
    const rawProvider = modelProviderEntries[providerId] ?? (inheritedFromProviderId ? modelProviderEntries[inheritedFromProviderId] : undefined);
    const hasModelsMetadata = rawProvider !== undefined;
    if (hasModelsMetadata && !isRecord(rawProvider)) {
      warnings.push(`Auto-import skipped provider '${providerId}': provider metadata${inheritedFromProviderId ? ` inherited from '${inheritedFromProviderId}'` : ""} is not an object.`);
      continue;
    }
    const provider = hasModelsMetadata ? (rawProvider as Record<string, unknown>) : {};
    const profile = getBuiltInProviderProfile(providerId) ?? (inheritedFromProviderId ? getBuiltInProviderProfile(inheritedFromProviderId) : undefined);
    if (!hasModelsMetadata && !profile) {
      warnUnsupportedAuthOnlyProvider(providerId, readFirstAuthCredentialKind(authRoot, group.credentialProviderIds), warnings);
      continue;
    }

    const api = typeof provider.api === "string" && provider.api ? provider.api : profile?.api ?? "";
    const apiSupportedByMetadata = SUPPORTED_AUTO_IMPORT_APIS.has(api);
    const apiSupportedByProfile = profile !== undefined && profile.api === api;
    if (!apiSupportedByMetadata && !apiSupportedByProfile) {
      warnings.push(`Auto-import skipped provider '${providerId}': unsupported api '${api || "missing"}'.`);
      continue;
    }

    const orderedCredentialProviderIds = orderCredentialProviderIds(providerId, group.credentialProviderIds, authRoot, provider, profile);
    const credential = resolveAutoImportCredentialFromCandidates(authRoot, providerId, orderedCredentialProviderIds, { autoImport, profile, warnings, options: { requireAuthJsonCredential: hasModelsMetadata } });
    if (!credential) continue;
    if (!hasModelsMetadata && profile && !builtInProfileAllowsAutoImportCredential(profile, credential.kind)) {
      if (credential.kind === "public") {
        warnings.push(`Auto-import skipped provider '${providerId}': built-in provider profile does not allow unauthenticated model discovery.`);
      } else {
        warnUnsupportedAuthOnlyProvider(providerId, credential.kind, warnings);
      }
      continue;
    }

    const credentialPool = resolveCredentialPool(authRoot, orderedCredentialProviderIds, autoImport, profile, credential);

    const rawBaseUrl = credential.baseUrl ?? (typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : undefined) ?? inferProfileBaseUrl(profile) ?? "";
    if (!rawBaseUrl) {
      warnings.push(`Auto-import skipped provider '${providerId}': baseUrl is missing and no built-in provider profile can infer it.`);
      continue;
    }
    const baseUrl = normalizeAutoImportedBaseUrl(rawBaseUrl, providerId, warnings);
    if (!baseUrl) continue;

    const discoveryType = inferAutoDiscoveryType(providerId, provider, autoImport, profile);
    if (!discoveryType) {
      warnings.push(`Auto-import skipped provider '${providerId}': no supported discovery protocol inferred.`);
      continue;
    }

    const effectiveBaseUrl = baseUrl;
    const inferredEndpointPath = inferAutoEndpointPath(providerId, effectiveBaseUrl, autoImport, profile);
    const endpointPath = validateEndpointPath(inferredEndpointPath, warnings, `Auto-import provider '${providerId}' discovery.endpointPath`);
    const discoveryEndpointPath = endpointPath.ok ? endpointPath.value : undefined;
    const fallbackModelIds = profile?.staticModelIds ? Array.from(profile.staticModelIds) : readFallbackModelIds(provider.models);
    const providerConfigLabel = `models.json.providers.${inheritedFromProviderId ?? providerId}`;
    const providerHeaders = sanitizeImportedHeaders(toStringRecord(provider.headers, warnings, `${providerConfigLabel}.headers`), warnings, `${providerConfigLabel}.headers`);

    providers.push({
      id: providerId,
      baseUrl: effectiveBaseUrl,
      apiKey: credential.apiKey,
      api: api as ProviderConfigEntry["api"],
      authHeader: credential.authHeader,
      headers: { ...(profile?.headers ?? {}), ...providerHeaders },
      maxModels: globalMaxModels,
      discovery: {
        type: discoveryType,
        enabled: autoImport.discovery.enabled,
        endpointPath: discoveryEndpointPath,
        headers: { ...autoImport.discovery.headers, ...(credential.headers ?? {}) },
        timeoutMs: autoImport.discovery.timeoutMs,
        ttlMs: autoImport.discovery.ttlMs,
        includeDetails: autoImport.discovery.includeDetails,
        allowModels: profile?.discoveryAllowModels ?? [],
        blockModels: profile?.discoveryBlockModels ?? [],
      },
      defaults: { ...(profile?.defaults ?? {}), ...normalizeDefaults(provider.defaults, warnings, `autoImport.providers.${inheritedFromProviderId ?? providerId}.defaults`) },
      modelDefaults: readModelDefaults(provider.models, warnings, inheritedFromProviderId ?? providerId),
      fallbackModelIds,
      source: "auto-import",
      credentials: credentialPool,
    });
  }
  return providers;
}

function mergeProviders(autoProviders: ProviderConfigEntry[], explicitProviders: ProviderConfigEntry[], warnings: string[]): ProviderConfigEntry[] {
  const merged = new Map<string, ProviderConfigEntry>();
  for (const provider of autoProviders) merged.set(provider.id, provider);
  for (const provider of explicitProviders) {
    if (merged.has(provider.id)) {
      warnings.push(`Explicit provider '${provider.id}' overrides auto-imported provider with the same ID.`);
    }
    merged.set(provider.id, provider);
  }
  return [...merged.values()];
}

function normalizeRegistrationConfig(value: unknown, warnings: string[]): RegistrationConfig {
  if (value === undefined) return { importMode: "replace" };
  if (!isRecord(value)) {
    warnings.push("registration must be an object; using replace import mode.");
    return { importMode: "replace" };
  }
  const importMode = value.importMode;
  if (importMode === undefined) return { importMode: "replace" };
  if (typeof importMode === "string" && (SUPPORTED_IMPORT_MODES as readonly string[]).includes(importMode)) {
    return { importMode: importMode as RegistrationImportMode };
  }
  warnings.push(`registration.importMode must be one of ${formatSupportedImportModes()}; using replace.`);
  return { importMode: "replace" };
}

function formatSupportedImportModes(): string {
  return SUPPORTED_IMPORT_MODES.join(", ");
}

/**
 * Resolve the Pi-Mono-managed built-in provider IDs. Prefers a dynamically
 * injected set (from the runtime model registry) so rename/addition tracking
 * is automatic; falls back to the static catalog only when no dynamic set is
 * available (e.g. the standalone verifier CLI).
 */
function resolveBuiltinProviderIds(injected?: ReadonlySet<string>): ReadonlySet<string> {
  return injected && injected.size > 0 ? injected : PI_MONO_BUILTIN_PROVIDER_FALLBACK_IDS;
}

/**
 * Resolve the broader pi-multi-auth-managed provider set (built-ins plus the
 * legacy alias ids cloudflare/qwen that pi-multi-auth owns).
 */
function resolveMultiAuthManagedProviderIds(builtinProviderIds: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...builtinProviderIds, ...PI_MULTI_AUTH_EXTRA_PROVIDER_IDS]);
}

function normalizeRegistrationOwnershipConflictMode(value: unknown, warnings: string[]): RegistrationOwnershipConflictMode {
  if (value === undefined) return "merge";
  if (value === "merge" || value === "skip") return value;
  warnings.push("registrationOwnership.onConflict must be one of merge, skip; using merge.");
  return "merge";
}

export async function loadConfigAsync(paths: LoaderPaths): Promise<ConfigLoadResult> {
  return loadConfigInternal(paths, loadHiddenProvidersFromMultiAuthConfig(paths.extensionRoot));
}

export function loadConfig(paths: LoaderPaths): ConfigLoadResult {
  return loadConfigInternal(paths, loadHiddenProvidersFromMultiAuthConfig(paths.extensionRoot));
}

function loadConfigInternal(paths: LoaderPaths, hiddenProviderResolution?: HiddenProviderResolution): ConfigLoadResult {
  const warnings: string[] = [];
  const builtinProviderIds = resolveBuiltinProviderIds(paths.builtinProviderIds);
  const configPath = paths.configPath ?? join(paths.extensionRoot, "config.json");
  const configDir = dirname(configPath);
  const defaultModelsJsonPath = paths.modelsJsonPath ?? resolveAgentJsonPath(paths.extensionRoot, "models.json");
  const defaultAuthJsonPath = paths.authJsonPath ?? resolveAgentJsonPath(paths.extensionRoot, "auth.json");
  const defaultMultiAuthJsonPath = paths.multiAuthJsonPath ?? resolveAgentJsonPath(paths.extensionRoot, "multi-auth.json");
  const cacheFileDefault = join(paths.extensionRoot, "cache.json");

  let rawConfig: unknown = {};
  if (existsSync(configPath)) {
    try {
      rawConfig = readJsonFile(configPath);
    } catch (error) {
      warnings.push(`Failed to parse config.json: ${error instanceof Error ? error.message : "unknown error"}; using safe defaults.`);
    }
  } else {
    warnings.push(`Missing config.json at ${configPath}; using safe defaults.`);
  }

  const raw = isRecord(rawConfig) ? rawConfig : {};
  const debug = raw.debug === true;
  const enabled = raw.enabled !== false;
  const cacheTTL = toPositiveInteger(raw.cacheTTL, warnings, "cacheTTL", DEFAULT_CACHE_TTL_MS);
  const maxModels = toPositiveInteger(raw.maxModels, warnings, "maxModels");
  const modelsDevRaw = isRecord(raw.modelsDev) ? raw.modelsDev : {};
  const openRouterRaw = isRecord(raw.openRouter) ? raw.openRouter : {};
  const existingProviderIds = loadExistingProviderIds(defaultModelsJsonPath, warnings);
  const rawAutoImport = isRecord(raw.autoImport) ? raw.autoImport : {};
  const multiAuthJsonPath = resolveConfigPath(rawAutoImport.multiAuthJsonPath, configDir, defaultMultiAuthJsonPath);
  warnings.push(...(hiddenProviderResolution?.warnings ?? []));
  const hiddenProviders = hiddenProviderResolution?.providers ?? loadHiddenProvidersFromMultiAuth(multiAuthJsonPath, warnings);
  const externalStaticProviderIds = loadExternalStaticProviderIdsFromExtensions(paths.extensionRoot, warnings);
  const autoImport = normalizeAutoImport(
    raw.autoImport,
    configDir,
    defaultModelsJsonPath,
    defaultAuthJsonPath,
    multiAuthJsonPath,
    hiddenProviders,
    externalStaticProviderIds,
    cacheTTL,
    warnings,
  );

  const explicitProviders = Array.isArray(raw.providers)
    ? raw.providers
        .map((provider, index) => normalizeProvider(provider, index, maxModels, cacheTTL, existingProviderIds, warnings))
        .filter((provider): provider is ProviderConfigEntry => provider !== undefined && !isSkippedProviderId(provider.id, autoImport))
    : [];
  if (raw.providers !== undefined && !Array.isArray(raw.providers)) {
    warnings.push("providers must be an array; no explicit providers loaded.");
  }

  const modelsRoot = autoImport.enabled ? readOptionalJson(autoImport.modelsJsonPath, warnings, "models.json") : undefined;
  const authRoot = autoImport.enabled ? readOptionalJson(autoImport.authJsonPath, warnings, "auth.json") : undefined;
  const autoProviders = autoImport.enabled ? loadAutoImportedProviders(autoImport, maxModels, authRoot ?? {}, modelsRoot, builtinProviderIds, warnings) : [];
  const registrationOwnershipRaw = isRecord(raw.registrationOwnership) ? raw.registrationOwnership : {};

  const cacheFile = typeof raw.cacheFile === "string" && raw.cacheFile.trim() ? resolve(configDir, raw.cacheFile) : cacheFileDefault;
  const config: ExtensionConfig = {
    enabled,
    debug,
    cacheTTL,
    cacheFile,
    maxModels,
    modelsDev: {
      enabled: modelsDevRaw.enabled !== false,
      url: normalizeModelsDevUrl(modelsDevRaw.url, warnings),
      timeoutMs: toPositiveInteger(modelsDevRaw.timeoutMs, warnings, "modelsDev.timeoutMs", DEFAULT_CATALOG_TIMEOUT_MS),
    },
    openRouter: {
      enabled: openRouterRaw.enabled !== false,
      url: normalizeOpenRouterUrl(openRouterRaw.url, warnings),
      timeoutMs: toPositiveInteger(openRouterRaw.timeoutMs, warnings, "openRouter.timeoutMs", DEFAULT_OPENROUTER_TIMEOUT_MS),
    },
    autoImport,
    providers: mergeProviders(autoProviders, explicitProviders, warnings),
    registration: normalizeRegistrationConfig(raw.registration, warnings),
    registrationOwnership: {
      managedProviderIds: resolvePiMultiAuthManagedProviderIds(builtinProviderIds, modelsRoot, authRoot, existingProviderIds),
      manager: "pi-multi-auth",
      onConflict: normalizeRegistrationOwnershipConflictMode(registrationOwnershipRaw.onConflict, warnings),
    },
  };

  return { config, warnings };
}
