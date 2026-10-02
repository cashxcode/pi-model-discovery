import type { CapabilityFlags, Cost, DiscoveryDefaults, InputModality, OutputModality, ProviderConfigEntry } from "../config/types.js";
import { applyModelFilters, buildDiscoveryHeaders, buildUrl, safeFetchJson } from "./helpers.js";
import { appendPaginationCursor, readPaginationState } from "./pagination.js";
import { resolveOpenAICompatibleModelsEndpoint } from "./provider-quirks.js";
import { pushUnique } from "../shared/arrays.js";
import { catalogVariantCombinationLookupIds, stripCatalogLookupPrefix } from "../shared/catalog-identity.js";
import { isRecord, readBooleanValue } from "../shared/validation.js";
import { readPricingIsFree } from "../shared/pricing.js";
import type { EndpointPricingMetadata, RawDiscoveredModel } from "./types.js";

interface OpenAIModelEntry {
  id?: unknown;
  object?: unknown;
  name?: unknown;
  display_name?: unknown;
  model?: unknown;
  created?: unknown;
  created_at?: unknown;
  owned_by?: unknown;
  provider_id?: unknown;
  routing_group?: unknown;
  description?: unknown;
  tags?: unknown;
  task?: unknown;
  properties?: unknown;
  context_length?: unknown;
  max_model_len?: unknown;
  meta?: unknown;
  source?: unknown;
  supports?: unknown;
  output_modalities?: unknown;
  supported_endpoints?: unknown;
  pricing?: unknown;
  isPremium?: unknown;
  is_premium?: unknown;
  required_plan?: unknown;
  requiredPlan?: unknown;
  min_plan_tier?: unknown;
  minPlanTier?: unknown;
  multiplier?: unknown;
  status?: unknown;
  type?: unknown;
  pool_size?: unknown;
  rateLimitRpm?: unknown;
  rate_limit_rpm?: unknown;
}

interface OpenAIModelsResponse {
  object?: unknown;
  base_url?: unknown;
  data?: OpenAIModelEntry[];
  result?: OpenAIModelEntry[];
}

const DEFAULT_PAGINATION_MAX_PAGES = 100;

function readDiscoveredModelId(entry: OpenAIModelEntry): string | undefined {
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (/^@(cf|hf)\//.test(name)) return name;
  return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
}

const MODALITY_SUPPORT_KEYS = ["text", "image", "imageGen", "videoGen", "musicGen", "tts", "stt", "embeddings"] as const;

function readStringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

function isOpenAITextCompletionEntry(entry: OpenAIModelEntry): boolean {
  const outputModalities = readStringArrayValue(entry.output_modalities).map((modality) => modality.toLowerCase());
  if (outputModalities.length > 0 && !outputModalities.includes("text")) return false;

  const supportedEndpoints = readStringArrayValue(entry.supported_endpoints).map((endpoint) => endpoint.toLowerCase());
  if (supportedEndpoints.length > 0 && !supportedEndpoints.some((endpoint) => endpoint.includes("chat/completions") || endpoint.includes("responses"))) return false;

  const supports = entry.supports;
  if (!isRecord(supports)) return true;
  if (supports.text === true) return true;
  if (supports.text === false) return false;
  return !MODALITY_SUPPORT_KEYS.some((key) => supports[key] === true);
}

function isTrueFlag(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readSupportsDefaults(value: unknown): DiscoveryDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const input: InputModality[] = [];
  const output: OutputModality[] = [];
  const capabilities: CapabilityFlags = {};

  if (isTrueFlag(value, "text")) {
    pushUnique(input, "text");
    pushUnique(output, "text");
  }
  if (isTrueFlag(value, "image")) {
    pushUnique(input, "image");
    capabilities.imageInput = true;
  }
  if (isTrueFlag(value, "imageGen")) {
    pushUnique(output, "image");
    capabilities.imageGeneration = true;
  }
  if (isTrueFlag(value, "videoGen")) {
    pushUnique(output, "video");
    capabilities.videoGeneration = true;
  }
  if (isTrueFlag(value, "musicGen")) {
    pushUnique(output, "audio");
    capabilities.musicGeneration = true;
  }
  if (isTrueFlag(value, "tts")) {
    pushUnique(output, "audio");
    capabilities.textToSpeech = true;
  }
  if (isTrueFlag(value, "stt")) {
    pushUnique(input, "audio");
    pushUnique(output, "text");
    capabilities.speechToText = true;
  }
  if (isTrueFlag(value, "embeddings")) capabilities.embeddings = true;
  if (isTrueFlag(value, "tools")) capabilities.toolCalling = true;
  if (isTrueFlag(value, "streaming")) capabilities.streaming = true;
  if (isTrueFlag(value, "rp")) capabilities.roleplay = true;

  const defaults: DiscoveryDefaults = {};
  if (input.length > 0) defaults.input = input;
  if (output.length > 0) defaults.output = output;
  if (Object.keys(capabilities).length > 0) defaults.capabilities = capabilities;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function readBooleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return undefined;
}

function readPositiveIntegerish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Prefer the server's effective context limit; model_max_tokens is not an output limit. */
function readContextDefaults(entry: OpenAIModelEntry): DiscoveryDefaults | undefined {
  const meta = isRecord(entry.meta) ? entry.meta : undefined;
  for (const value of [entry.context_length, entry.max_model_len, meta?.context_length]) {
    const contextWindow = readPositiveIntegerish(value);
    if (contextWindow !== undefined && Number.isSafeInteger(contextWindow)) return { contextWindow };
  }
  return undefined;
}

function mergeDefaults(...defaults: Array<DiscoveryDefaults | undefined>): DiscoveryDefaults | undefined {
  const merged: DiscoveryDefaults = {};
  for (const entry of defaults) {
    if (!entry) continue;
    if (entry.baseUrl !== undefined) merged.baseUrl = entry.baseUrl;
    if (entry.reasoning !== undefined) merged.reasoning = entry.reasoning;
    if (entry.thinkingLevelMap !== undefined) merged.thinkingLevelMap = { ...(merged.thinkingLevelMap ?? {}), ...entry.thinkingLevelMap };
    if (entry.input !== undefined) merged.input = Array.from(new Set([...(merged.input ?? []), ...entry.input]));
    if (entry.output !== undefined) merged.output = Array.from(new Set([...(merged.output ?? []), ...entry.output]));
    if (entry.capabilities !== undefined) merged.capabilities = { ...(merged.capabilities ?? {}), ...entry.capabilities };
    if (entry.cost !== undefined) merged.cost = { ...(merged.cost ?? {}), ...entry.cost };
    if (entry.contextWindow !== undefined) merged.contextWindow = entry.contextWindow;
    if (entry.maxTokens !== undefined) merged.maxTokens = entry.maxTokens;
    if (entry.compat !== undefined) merged.compat = { ...(merged.compat ?? {}), ...entry.compat };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readCloudflarePriceCost(value: unknown): Partial<Cost> | undefined {
  if (!Array.isArray(value)) return undefined;
  const cost: Partial<Cost> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.unit !== "string" || typeof entry.price !== "number" || !Number.isFinite(entry.price) || entry.price < 0) continue;
    const unit = entry.unit.toLowerCase();
    if (unit.includes("cached input")) cost.cacheRead = entry.price;
    else if (unit.includes("input")) cost.input = entry.price;
    else if (unit.includes("output")) cost.output = entry.price;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function readCloudflareProperties(value: unknown): { defaults?: DiscoveryDefaults; metadata?: NonNullable<RawDiscoveredModel["endpointMetadata"]>["cloudflare"] } {
  if (!Array.isArray(value)) return {};
  const defaults: DiscoveryDefaults = {};
  const capabilities: CapabilityFlags = {};
  const metadata: NonNullable<RawDiscoveredModel["endpointMetadata"]>["cloudflare"] = {};

  for (const property of value) {
    if (!isRecord(property) || typeof property.property_id !== "string") continue;
    const propertyId = property.property_id;
    const propertyValue = property.value;
    if (propertyId === "context_window") {
      const contextWindow = readPositiveIntegerish(propertyValue);
      if (contextWindow !== undefined) defaults.contextWindow = contextWindow;
      continue;
    }
    if (propertyId === "reasoning") {
      const reasoning = readBooleanish(propertyValue);
      if (reasoning !== undefined) defaults.reasoning = reasoning;
      continue;
    }
    if (propertyId === "vision" && readBooleanish(propertyValue) === true) {
      defaults.input = Array.from(new Set([...(defaults.input ?? ["text"]), "image"]));
      capabilities.imageInput = true;
      continue;
    }
    if (propertyId === "function_calling") {
      const supportsTools = readBooleanish(propertyValue);
      if (supportsTools !== undefined) capabilities.toolCalling = supportsTools;
      continue;
    }
    if (propertyId === "price") {
      const cost = readCloudflarePriceCost(propertyValue);
      if (cost) defaults.cost = { ...(defaults.cost ?? {}), ...cost };
      continue;
    }
    if (propertyId === "beta") metadata.beta = readBooleanish(propertyValue);
    if (propertyId === "lora") metadata.lora = readBooleanish(propertyValue);
    if (propertyId === "async_queue") metadata.asyncQueue = readBooleanish(propertyValue);
    if (propertyId === "planned_deprecation_date" && typeof propertyValue === "string" && propertyValue.trim()) metadata.plannedDeprecationDate = propertyValue.trim();
    if (propertyId === "info" && typeof propertyValue === "string" && propertyValue.trim()) metadata.infoUrl = propertyValue.trim();
    if (propertyId === "terms" && typeof propertyValue === "string" && propertyValue.trim()) metadata.termsUrl = propertyValue.trim();
    if (propertyId === "max_input_length") metadata.maxInputLength = readPositiveIntegerish(propertyValue);
    if (propertyId === "max_total_tokens") metadata.maxTotalTokens = readPositiveIntegerish(propertyValue);
    if (propertyId === "max_batch_prefill_tokens") metadata.maxBatchPrefillTokens = readPositiveIntegerish(propertyValue);
  }

  if (Object.keys(capabilities).length > 0) defaults.capabilities = { ...(defaults.capabilities ?? {}), ...capabilities };
  return {
    defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
    metadata: Object.values(metadata).some((entry) => entry !== undefined) ? metadata : undefined,
  };
}

function readLookupSeed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = stripCatalogLookupPrefix(value);
  return normalized.length > 0 ? normalized : undefined;
}

function readOriginProviderLookupIds(seed: string): string[] {
  if (/^claude(?:[-_/]|$)/i.test(seed)) return [`anthropic/${seed}`];
  return [];
}

function readCatalogLookupIds(entry: OpenAIModelEntry, id: string): string[] | undefined {
  const lookupIds: string[] = [];
  for (const seed of [readLookupSeed(entry.provider_id), readLookupSeed(entry.routing_group), id]) {
    if (!seed) continue;
    for (const alias of readOriginProviderLookupIds(seed)) pushUnique(lookupIds, alias);
    if (seed !== id) pushUnique(lookupIds, seed);
    for (const alias of catalogVariantCombinationLookupIds(seed)) {
      for (const originAlias of readOriginProviderLookupIds(alias)) pushUnique(lookupIds, originAlias);
      if (alias !== id) pushUnique(lookupIds, alias);
    }
  }
  return lookupIds.length > 0 ? lookupIds : undefined;
}

function readStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (isNonNegativeFiniteNumber(value)) return value;
  }
  return undefined;
}

function isFreePlan(plan: string): boolean {
  return /^(free|public|community|developer)$/i.test(plan.trim());
}

function isPaidPlan(plan: string): boolean {
  return /\b(paid|premium|pro|plus|team|business|enterprise)\b/i.test(plan);
}

function deriveIsFree(isPremium: boolean | undefined, requiredPlan: string | undefined, multiplier: number | undefined): boolean | undefined {
  if (isPremium !== undefined) return !isPremium;
  if (requiredPlan) {
    if (isPaidPlan(requiredPlan)) return false;
    if (isFreePlan(requiredPlan)) return true;
  }
  return multiplier === 0 ? true : undefined;
}

function readPlanTierValue(...values: unknown[]): number | string | undefined {
  for (const value of values) {
    if (isNonNegativeFiniteNumber(value)) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readEndpointPricing(entry: OpenAIModelEntry): EndpointPricingMetadata | undefined {
  const isPremium = readBooleanValue(entry.isPremium, entry.is_premium);
  const requiredPlan = readStringValue(entry.required_plan, entry.requiredPlan);
  const minPlanTier = readPlanTierValue(entry.min_plan_tier, entry.minPlanTier);
  const multiplier = readNumberValue(entry.multiplier);
  const isFree = deriveIsFree(isPremium, requiredPlan, multiplier) ?? readPricingIsFree(entry.pricing);
  const pricing: EndpointPricingMetadata = {};
  if (isFree !== undefined) pricing.isFree = isFree;
  if (isPremium !== undefined) pricing.isPremium = isPremium;
  if (requiredPlan !== undefined) pricing.requiredPlan = requiredPlan;
  if (minPlanTier !== undefined) pricing.minPlanTier = minPlanTier;
  if (multiplier !== undefined) pricing.multiplier = multiplier;
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function readCreatedTimestamp(entry: OpenAIModelEntry): number | undefined {
  if (typeof entry.created === "number" && Number.isFinite(entry.created)) return entry.created;
  if (typeof entry.created_at !== "string" || !entry.created_at.trim()) return undefined;
  const parsed = Date.parse(entry.created_at.includes("T") ? entry.created_at : entry.created_at.replace(" ", "T"));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function readTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return tags.length > 0 ? Array.from(new Set(tags)) : undefined;
}

function readTaskMetadata(value: unknown): NonNullable<NonNullable<RawDiscoveredModel["endpointMetadata"]>["cloudflare"]>["task"] | undefined {
  if (!isRecord(value)) return undefined;
  const task = {
    id: readStringValue(value.id),
    name: readStringValue(value.name),
    description: readStringValue(value.description),
  };
  return Object.values(task).some((entry) => entry !== undefined) ? task : undefined;
}

function readEndpointMetadata(
  entry: OpenAIModelEntry,
  cloudflarePropertyMetadata: NonNullable<RawDiscoveredModel["endpointMetadata"]>["cloudflare"] | undefined,
  responseBaseUrl?: string,
): RawDiscoveredModel["endpointMetadata"] {
  const cloudflareTask = readTaskMetadata(entry.task);
  const cloudflare = {
    source: readNumberValue(entry.source),
    task: cloudflareTask,
    ...(cloudflarePropertyMetadata ?? {}),
  };
  const metadata: NonNullable<RawDiscoveredModel["endpointMetadata"]> = {};
  const object = readStringValue(entry.object);
  const providerId = readStringValue(entry.provider_id);
  const routingGroup = readStringValue(entry.routing_group);
  const status = readStringValue(entry.status);
  const type = readStringValue(entry.type);
  const poolSize = readNumberValue(entry.pool_size);
  const rateLimitRpm = readNumberValue(entry.rateLimitRpm, entry.rate_limit_rpm);

  if (object !== undefined) metadata.object = object;
  if (providerId !== undefined) metadata.providerId = providerId;
  if (routingGroup !== undefined) metadata.routingGroup = routingGroup;
  if (status !== undefined) metadata.status = status;
  if (type !== undefined) metadata.type = type;
  if (poolSize !== undefined) metadata.poolSize = poolSize;
  if (rateLimitRpm !== undefined) metadata.rateLimitRpm = rateLimitRpm;
  if (responseBaseUrl !== undefined) metadata.responseBaseUrl = responseBaseUrl;
  if (Object.values(cloudflare).some((value) => value !== undefined)) metadata.cloudflare = cloudflare;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readModelEntries(payload: unknown): OpenAIModelEntry[] {
  if (Array.isArray(payload)) return payload as OpenAIModelEntry[];
  if (!isRecord(payload)) {
    throw new Error("Malformed OpenAI-compatible discovery payload: expected an object with data[] or result[], or an array.");
  }
  if (Array.isArray(payload.data)) return payload.data as OpenAIModelEntry[];
  if (Array.isArray(payload.result)) return payload.result as OpenAIModelEntry[];
  throw new Error("Malformed OpenAI-compatible discovery payload: expected data[] or result[] model list.");
}

function parseOpenAIModelEntries(entries: OpenAIModelEntry[], responseBaseUrl?: string): RawDiscoveredModel[] {
  const parsed: RawDiscoveredModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isOpenAITextCompletionEntry(entry)) continue;
    const id = readDiscoveredModelId(entry);
    if (!id) continue;
    const model: RawDiscoveredModel = { id };
    const name = readStringValue(entry.name, entry.display_name, entry.model);
    if (name) model.name = name;
    const description = readStringValue(entry.description);
    if (description) model.description = description;
    const created = readCreatedTimestamp(entry);
    if (created !== undefined) model.created = created;
    if (typeof entry.owned_by === "string") model.ownedBy = entry.owned_by;
    const tags = readTags(entry.tags);
    if (tags) model.tags = tags;
    const cloudflareProperties = readCloudflareProperties(entry.properties);
    const defaults = mergeDefaults(readSupportsDefaults(entry.supports), cloudflareProperties.defaults, readContextDefaults(entry));
    if (defaults) model.defaults = defaults;
    const catalogLookupIds = readCatalogLookupIds(entry, id);
    if (catalogLookupIds) model.catalogLookupIds = catalogLookupIds;
    const endpointPricing = readEndpointPricing(entry);
    if (endpointPricing) model.endpointPricing = endpointPricing;
    const endpointMetadata = readEndpointMetadata(entry, cloudflareProperties.metadata, responseBaseUrl);
    if (endpointMetadata) model.endpointMetadata = endpointMetadata;
    parsed.push(model);
  }
  return parsed;
}

function filterAndDedupeModels(models: RawDiscoveredModel[], provider: ProviderConfigEntry): RawDiscoveredModel[] {
  const allowedIds = new Set(applyModelFilters(models.map((model) => model.id), provider));
  const seen = new Set<string>();
  const filtered: RawDiscoveredModel[] = [];
  for (const model of models) {
    if (!allowedIds.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    filtered.push(model);
  }
  return filtered;
}

export function parseOpenAIModelsResponse(payload: OpenAIModelsResponse, provider: ProviderConfigEntry): RawDiscoveredModel[] {
  const responseBaseUrl = readStringValue(payload.base_url);
  return filterAndDedupeModels(parseOpenAIModelEntries(readModelEntries(payload), responseBaseUrl), provider);
}

export async function discoverOpenAICompat(provider: ProviderConfigEntry): Promise<RawDiscoveredModel[]> {
  const endpointPath = resolveOpenAICompatibleModelsEndpoint(provider);
  const initialUrl = buildUrl(provider.baseUrl, endpointPath);
  const headers = buildDiscoveryHeaders(provider);
  const pagination = provider.discovery.pagination?.enabled ? provider.discovery.pagination : undefined;
  const maxPages = pagination?.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES;
  const models: RawDiscoveredModel[] = [];
  let url = initialUrl;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await safeFetchJson<unknown>(url, { method: "GET", headers }, provider.discovery.timeoutMs);
    if (!response.ok || response.data === undefined) {
      throw new Error(response.error ?? "OpenAI-compatible model discovery failed");
    }

    const responseBaseUrl = isRecord(response.data) ? readStringValue(response.data.base_url) : undefined;
    models.push(...parseOpenAIModelEntries(readModelEntries(response.data), responseBaseUrl));
    if (!pagination) break;

    const pageState = readPaginationState(response.data, pagination);
    if (!pageState.hasMore) break;
    if (page + 1 >= maxPages) {
      throw new Error(`OpenAI-compatible pagination stopped after maxPages=${maxPages} while the provider still reported more pages.`);
    }
    if (!pageState.nextCursor) {
      throw new Error("Malformed OpenAI-compatible pagination payload: has_more is true but no next cursor was provided.");
    }
    url = appendPaginationCursor(initialUrl, pagination.cursorParam, pageState.nextCursor);
  }

  return filterAndDedupeModels(models, provider);
}
