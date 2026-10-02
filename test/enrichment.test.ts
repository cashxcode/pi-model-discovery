import test from "node:test";
import { parseOpenAIModelsResponse } from "../src/discovery/openai-compat.js";
import assert from "node:assert/strict";

import type { DiscoveredModel } from "../src/cache/types.js";
import type { ProviderConfigEntry } from "../src/config/types.js";
import { createTestApiKey } from "./support/secrets.js";
import { classifyFreeModels } from "../src/enrichment/free-classifier.js";
import { enrichProviderModels } from "../src/enrichment/merger.js";
import type { ModelsDevLookup } from "../src/enrichment/models-dev.js";

const TEST_API_KEY = createTestApiKey("enrichment");

const provider: ProviderConfigEntry = {
  id: "providerx",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: TEST_API_KEY,
  api: "openai-completions" as ProviderConfigEntry["api"],
  authHeader: true,
  headers: {},
  discovery: {
    type: "openai-compat",
    enabled: true,
    headers: {},
    timeoutMs: 1000,
    ttlMs: 60_000,
    includeDetails: false,
    allowModels: [],
    blockModels: [],
  },
  defaults: {
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  modelDefaults: {},
  source: "explicit",
};

function model(id: string, name: string, inputCost: number, outputCost: number): DiscoveredModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    sources: {},
  };
}

test("enrichment applies cache before models.dev so catalog metadata replaces stale cached values", () => {
  const lookup: ModelsDevLookup = new Map([
    ["raw-model", { id: "raw-model", name: "Raw Model", reasoning: false, contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 2 } }],
  ]);
  const enriched = enrichProviderModels(provider, [{ id: "raw-model" }], lookup, [model("raw-model", "Cached Name", 3, 4)]);
  assert.equal(enriched[0]?.id, "raw-model");
  assert.equal(enriched[0]?.name, "Raw Model");
  assert.equal(enriched[0]?.reasoning, true);
  assert.deepEqual(enriched[0]?.input, ["text", "image"]);
  assert.equal(enriched[0]?.contextWindow, 1_048_576);
  assert.equal(enriched[0]?.maxTokens, 65_536);
});

test("enrichment uses endpoint aliases for models.dev and keeps catalog metadata newer than cache defaults", () => {
  const lookup: ModelsDevLookup = new Map([
    [
      "qwen3.6-plus",
      {
        id: "qwen3.6-plus",
        name: "Qwen3.6 Plus",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        cost: { input: 0.276, output: 1.651, cacheRead: 0.028, cacheWrite: 0.344 },
      },
    ],
  ]);
  const enriched = enrichProviderModels(
    { ...provider, defaults: {} },
    [
      {
        id: "qwen3.6-plus-thinking-search",
        catalogLookupIds: ["qwen3.6-plus"],
        defaults: {
          input: ["text", "image"],
          output: ["text"],
          capabilities: { toolCalling: true, streaming: true },
        },
      } as never,
    ],
    lookup,
    [
      {
        ...model("qwen3.6-plus-thinking-search", "Cached Variant", 0, 0),
        sources: { dynamic: true, globalDefaults: true },
        capabilityProvenance: { id: "dynamic" },
      },
    ],
  );

  assert.deepEqual(
    {
      name: enriched[0]?.name,
      reasoning: enriched[0]?.reasoning,
      input: enriched[0]?.input,
      output: enriched[0]?.output,
      capabilities: enriched[0]?.capabilities,
      cost: enriched[0]?.cost,
      contextWindow: enriched[0]?.contextWindow,
      maxTokens: enriched[0]?.maxTokens,
    },
    {
      name: "Qwen3.6 Plus",
      reasoning: true,
      input: ["text", "image"],
      output: ["text"],
      capabilities: { toolCalling: true, streaming: true },
      cost: { input: 0.276, output: 1.651, cacheRead: 0.028, cacheWrite: 0.344 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    },
  );
});

test("enrichment prefers endpoint catalog aliases over ambiguous unscoped model IDs", () => {
  const lookup: ModelsDevLookup = new Map([
    [
      "claude-opus-4.7",
      {
        id: "claude-opus-4.7",
        name: "Gateway-specific non-reasoning alias",
        reasoning: false,
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
    ],
    [
      "anthropic/claude-opus-4.7",
      {
        id: "anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ],
  ]);

  const [enriched] = enrichProviderModels(
    { ...provider, id: "blazeapi", source: "auto-import", defaults: {}, modelDefaults: {} },
    [
      {
        id: "claude-opus-4.7",
        catalogLookupIds: ["anthropic/claude-opus-4.7", "claude-opus-4.7"],
        defaults: { input: ["text"], output: ["text"], capabilities: { streaming: true } },
      } as never,
    ],
    lookup,
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      reasoning: enriched?.reasoning,
      maxTokens: enriched?.maxTokens,
      cost: enriched?.cost,
      provenance: enriched?.capabilityProvenance?.reasoning,
    },
    {
      name: "Claude Opus 4.7",
      reasoning: true,
      maxTokens: 128_000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      provenance: "modelsDev",
    },
  );
});

test("enrichment resolves uniquely matching unscoped gateway IDs by catalog suffix", () => {
  const lookup: ModelsDevLookup = new Map([
    [
      "google/gemini-2.0-flash-lite-001",
      {
        id: "google/gemini-2.0-flash-lite-001",
        canonicalId: "google/gemini-2.0-flash-lite-001",
        name: "Gemini 2.0 Flash Lite",
        reasoning: false,
        contextWindow: 1_048_576,
        maxTokens: 8_192,
        cost: { input: 0.1, output: 0.4 },
      },
    ],
  ]) as ModelsDevLookup;

  const [enriched] = enrichProviderModels(
    { ...provider, id: "swtaiapi", defaults: {}, modelDefaults: {} },
    [{ id: "gemini-2.0-flash-lite-001" }],
    lookup,
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
      provenance: enriched?.capabilityProvenance?.contextWindow,
    },
    {
      name: "Gemini 2.0 Flash Lite",
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      provenance: "modelsDev",
    },
  );
});

test("enrichment leaves ambiguous unscoped suffix matches unresolved", () => {
  const lookup: ModelsDevLookup = new Map([
    ["meta/llama-4-maverick-17b-128e-instruct", { id: "meta/llama-4-maverick-17b-128e-instruct", canonicalId: "meta/llama-4-maverick-17b-128e-instruct", name: "Meta Maverick", contextWindow: 1_000_000, maxTokens: 128_000 }],
    ["groq-llama-4-maverick-17b-128e-instruct", { id: "groq-llama-4-maverick-17b-128e-instruct", canonicalId: "groq-llama-4-maverick-17b-128e-instruct", name: "Groq Maverick", contextWindow: 131_072, maxTokens: 16_384 }],
  ]) as ModelsDevLookup;

  const [enriched] = enrichProviderModels(
    { ...provider, id: "swtaiapi", defaults: {}, modelDefaults: {} },
    [{ id: "llama-4-maverick-17b-128e-instruct" }],
    lookup,
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
      modelsDev: enriched?.sources.modelsDev,
    },
    {
      name: "Llama 4 Maverick 17b 128e Instruct (swtaiapi)",
      contextWindow: 128_000,
      maxTokens: 16_384,
      modelsDev: undefined,
    },
  );
});

test("enrichment keeps BlazeAPI Claude routes OpenAI-compatible but disables reasoning_effort", () => {
  const [enriched] = enrichProviderModels(
    {
      ...provider,
      id: "blazeapi",
      baseUrl: "https://blazeai.boxu.dev/api/",
      source: "auto-import",
      defaults: {},
      modelDefaults: {},
    },
    [
      {
        id: "openai-compatible-opus-4.7",
        defaults: {
          reasoning: true,
          compat: { supportsReasoningEffort: true, supportsStore: false },
        },
        endpointMetadata: {
          providerId: "route:claude-opus-4.7",
          routingGroup: "openai-compatible-opus-4.7",
        },
      } as never,
    ],
    new Map(),
  );

  assert.deepEqual(
    {
      api: enriched?.api,
      baseUrl: enriched?.baseUrl,
      reasoning: enriched?.reasoning,
      compat: enriched?.compat,
      compatProvenance: enriched?.capabilityProvenance?.compat,
    },
    {
      api: undefined,
      baseUrl: undefined,
      reasoning: true,
      compat: { supportsReasoningEffort: false, supportsStore: false },
      compatProvenance: "providerQuirk",
    },
  );
});

test("enrichment keeps exact model IDs ahead of non-origin variant aliases", () => {
  const lookup: ModelsDevLookup = new Map([
    ["moonshotai/kimi-k2", { id: "moonshotai/kimi-k2", name: "Kimi K2", reasoning: false, contextWindow: 131_072, maxTokens: 32_768 }],
    ["moonshotai/kimi-k2-thinking", { id: "moonshotai/kimi-k2-thinking", name: "Kimi K2 Thinking", reasoning: true, contextWindow: 216_144, maxTokens: 216_144 }],
  ]);

  const [enriched] = enrichProviderModels(
    { ...provider, id: "blazeapi", source: "auto-import", defaults: {}, modelDefaults: {} },
    [{ id: "moonshotai/kimi-k2-thinking", catalogLookupIds: ["moonshotai/kimi-k2"] } as never],
    lookup,
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      reasoning: enriched?.reasoning,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
    },
    {
      name: "Kimi K2 Thinking",
      reasoning: true,
      contextWindow: 216_144,
      maxTokens: 216_144,
    },
  );
});

test("enrichment strips gateway variants before catalog lookup and enables OpenAI-compatible reasoning controls", () => {
  const lookup: ModelsDevLookup = new Map([
    [
      "gpt-5.5",
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text", "image"],
        output: ["text"],
        capabilities: { toolCalling: true, structuredOutputs: true, temperature: false },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 5, output: 30, cacheRead: 0.5 },
      },
    ],
  ]);

  const [enriched] = enrichProviderModels(
    { ...provider, id: "qianxiang", source: "auto-import", defaults: {}, modelDefaults: {} },
    [{ id: "gpt-5.5-openai-compact" }],
    lookup,
    [
      {
        ...model("gpt-5.5-openai-compact", "Cached Compact", 0, 0),
        sources: { dynamic: true, globalDefaults: true },
        capabilityProvenance: { id: "dynamic" },
      },
    ],
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      reasoning: enriched?.reasoning,
      input: enriched?.input,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
      compat: enriched?.compat,
      thinkingLevelMap: enriched?.thinkingLevelMap,
      provenance: enriched?.capabilityProvenance,
    },
    {
      name: "GPT-5.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
      provenance: {
        id: "dynamic",
        name: "modelsDev",
        reasoning: "modelsDev",
        input: "modelsDev",
        output: "modelsDev",
        capabilities: "modelsDev",
        cost: "modelsDev",
        contextWindow: "modelsDev",
        maxTokens: "modelsDev",
        compat: "reasoningCompatDefaults",
        thinkingLevelMap: "reasoningCompatDefaults",
      },
    },
  );
});

test("auto-import enrichment lets models.json defaults override catalog metadata", () => {
  const lookup: ModelsDevLookup = new Map([
    [
      "auto-model",
      {
        id: "auto-model",
        name: "Catalog Auto Model",
        reasoning: true,
        input: ["text", "image"],
        output: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  ]);

  const [enriched] = enrichProviderModels(
    {
      ...provider,
      source: "auto-import",
      defaults: {},
      modelDefaults: {
        "auto-model": {
          name: "Models JSON Name",
          reasoning: false,
          input: ["text"],
          cost: { input: 9, output: 9 },
          contextWindow: 32_000,
          maxTokens: 4096,
        },
      },
    },
    [{ id: "auto-model" }],
    lookup,
    [model("auto-model", "Cached Name", 7, 8)],
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      reasoning: enriched?.reasoning,
      input: enriched?.input,
      output: enriched?.output,
      cost: enriched?.cost,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
      provenance: enriched?.capabilityProvenance,
    },
    {
      name: "Models JSON Name",
      reasoning: false,
      input: ["text"],
      output: ["text"],
      cost: { input: 9, output: 9, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 32_000,
      maxTokens: 4096,
      provenance: {
        id: "dynamic",
        name: "modelsJsonDefaults",
        reasoning: "modelsJsonDefaults",
        input: "modelsJsonDefaults",
        output: "modelsDev",
        cost: "modelsJsonDefaults",
        contextWindow: "modelsJsonDefaults",
        maxTokens: "modelsJsonDefaults",
      },
    },
  );
});

test("free classifier uses cost when pricing is exposed and name when pricing is not exposed", () => {
  const priced = classifyFreeModels([model("paid", "Paid", 1, 2), model("zero", "Not Labelled", 0, 0)]);
  assert.equal(priced.find((entry) => entry.id === "zero")?.isFree, true);
  assert.equal(priced.find((entry) => entry.id === "paid")?.isFree, false);

  const unpriced = classifyFreeModels([model("a", "Free Tier", 0, 0), model("b", "Standard", 0, 0)]);
  assert.equal(unpriced.find((entry) => entry.id === "a")?.isFree, true);
  assert.equal(unpriced.find((entry) => entry.id === "b")?.isFree, false);
});

test("endpoint pricing hints override catalog pricing when provider account exposes free and premium tiers", () => {
  const lookup: ModelsDevLookup = new Map([
    ["free-provider-model", { id: "free-provider-model", name: "Catalog Paid", cost: { input: 1, output: 2 } }],
    ["premium-provider-model", { id: "premium-provider-model", name: "Catalog Zero", cost: { input: 0, output: 0 } }],
  ]);

  const enriched = enrichProviderModels(
    { ...provider, defaults: {} },
    [
      { id: "free-provider-model", endpointPricing: { isFree: true, isPremium: false, requiredPlan: "Free", multiplier: 1 } },
      { id: "premium-provider-model", endpointPricing: { isFree: false, isPremium: true, requiredPlan: "Free", multiplier: 4 } },
    ],
    lookup,
  );

  assert.deepEqual(
    enriched.map((entry) => ({ id: entry.id, isFree: entry.isFree, endpointPricing: entry.sources.endpointPricing })),
    [
      { id: "free-provider-model", isFree: true, endpointPricing: true },
      { id: "premium-provider-model", isFree: false, endpointPricing: true },
    ],
  );
});


test("refreshed server context replaces cached limits in both directions while explicit overrides win", () => {
  const remoteProvider = { ...provider, defaults: {}, modelDefaults: {} };
  const response = (context_length: number) => parseOpenAIModelsResponse({ data: [{ id: "mlx-chat", context_length }] }, remoteProvider);
  let cached = enrichProviderModels(remoteProvider, response(262144), new Map());
  for (const limit of [1048576, 131072]) {
    cached = enrichProviderModels(remoteProvider, response(limit), new Map(), cached);
    assert.equal(cached[0]?.contextWindow, limit);
    assert.equal(cached[0]?.capabilityProvenance?.contextWindow, "endpointDetails");
  }
  const overridden = { ...remoteProvider, modelDefaults: { "mlx-chat": { contextWindow: 1000000 } } };
  cached = enrichProviderModels(overridden, response(524288), new Map(), cached);
  assert.equal(cached[0]?.contextWindow, 1000000);
  cached = enrichProviderModels(remoteProvider, response(524288), new Map(), cached);
  assert.equal(cached[0]?.contextWindow, 524288);
});
