import test from "node:test";
import assert from "node:assert/strict";

import type { ProviderConfigEntry } from "../src/config/types.js";
import { createTestApiKey } from "./support/secrets.js";
import { buildDiscoveryHeaders, buildUrl } from "../src/discovery/helpers.js";
import { parseOpenAIModelsResponse } from "../src/discovery/openai-compat.js";

const TEST_API_KEY = createTestApiKey("discovery");

const provider: ProviderConfigEntry = {
  id: "myproxy-discovery",
  baseUrl: "http://127.0.0.1:8000/v1/",
  apiKey: TEST_API_KEY,
  api: "openai-completions" as ProviderConfigEntry["api"],
  authHeader: true,
  headers: { "x-runtime": "enabled" },
  maxModels: 10,
  discovery: {
    type: "openai-compat",
    enabled: true,
    headers: { "x-discovery": "enabled" },
    timeoutMs: 1000,
    ttlMs: 60_000,
    includeDetails: false,
    allowModels: [],
    blockModels: [],
  },
  defaults: {},
  modelDefaults: {},
  source: "explicit",
};

test("OpenAI-compatible parser preserves discovered model IDs verbatim", () => {
  const models = parseOpenAIModelsResponse(
    { data: [{ id: "gemini_cli/gemini-3-flash-preview", created: 1, owned_by: "proxy" }] },
    provider,
  );
  assert.equal(models[0]?.id, "gemini_cli/gemini-3-flash-preview");
});

test("OpenAI-compatible parser maps provider capability metadata into endpoint defaults", () => {
  const models = parseOpenAIModelsResponse(
    {
      data: [
        {
          id: "qwen3.6-plus-thinking-search",
          provider_id: "qwen3.6-plus",
          supports: {
            text: true,
            image: true,
            imageGen: false,
            videoGen: false,
            musicGen: false,
            tts: false,
            stt: false,
            embeddings: false,
            tools: true,
            streaming: true,
          },
        } as never,
      ],
    },
    provider,
  );

  assert.deepEqual(models[0]?.defaults, {
    input: ["text", "image"],
    output: ["text"],
    capabilities: {
      imageInput: true,
      streaming: true,
      toolCalling: true,
    },
  });
  assert.deepEqual((models[0] as unknown as { catalogLookupIds?: string[] })?.catalogLookupIds, [
    "qwen3.6-plus",
    "qwen3.6-plus-thinking",
    "qwen3.6-plus-search",
  ]);
});

test("OpenAI-compatible parser skips models that only advertise non-text modalities", () => {
  const models = parseOpenAIModelsResponse(
    {
      data: [
        { id: "text-chat", supports: { text: true, streaming: true } } as never,
        { id: "image-generator", supports: { imageGen: true, streaming: true } } as never,
        { id: "music-generator", supports: { musicGen: true, streaming: true } } as never,
        { id: "speech-generator", supports: { tts: true, streaming: true } } as never,
        { id: "speech-to-text", supports: { stt: true, streaming: true } } as never,
      ],
    },
    provider,
  );

  assert.deepEqual(
    models.map((model) => model.id),
    ["text-chat"],
  );
});

test("OpenAI-compatible parser adds origin-provider catalog aliases for unscoped Claude gateway routes", () => {
  const models = parseOpenAIModelsResponse(
    {
      data: [
        {
          id: "claude-opus-4.7",
          provider_id: "route:claude-opus-4.7",
          routing_group: "claude-opus-4.7",
          supports: { text: true, streaming: true },
        } as never,
      ],
    },
    provider,
  );

  assert.deepEqual((models[0] as unknown as { catalogLookupIds?: string[] })?.catalogLookupIds, [
    "anthropic/claude-opus-4.7",
  ]);
});

test("OpenAI-compatible parser maps endpoint premium plan metadata into pricing hints", () => {
  const models = parseOpenAIModelsResponse(
    {
      data: [
        { id: "qwen3.6-plus", isPremium: false, required_plan: "Free", multiplier: 1 } as never,
        { id: "claude-opus-4.7", isPremium: true, required_plan: "Free", multiplier: 4 } as never,
      ],
    },
    provider,
  );

  assert.deepEqual(
    models.map((model) => ({ id: model.id, endpointPricing: model.endpointPricing })),
    [
      { id: "qwen3.6-plus", endpointPricing: { isFree: true, isPremium: false, requiredPlan: "Free", multiplier: 1 } },
      { id: "claude-opus-4.7", endpointPricing: { isFree: false, isPremium: true, requiredPlan: "Free", multiplier: 4 } },
    ],
  );
});

test("OpenAI-compatible parser maps BlazeAPI status, plan tiers, endpoint base URL, and rp support metadata", () => {
  const models = parseOpenAIModelsResponse(
    {
      object: "list",
      base_url: "https://blazeai.boxu.dev/api/",
      data: [
        {
          id: "grok-4.20-fast",
          object: "model",
          owned_by: "blazeapi",
          provider_id: "grok-4.20-fast",
          routing_group: "route:grok-4.20-fast",
          multiplier: 2,
          supports: {
            text: true,
            image: false,
            imageGen: false,
            videoGen: false,
            musicGen: false,
            tts: false,
            stt: false,
            embeddings: false,
            tools: true,
            streaming: true,
            rp: true,
          },
          status: "healthy",
          isPremium: false,
          type: "routing_group",
          pool_size: 0,
          required_plan: "Free",
          min_plan_tier: 1,
          minPlanTier: 2,
          rateLimitRpm: 120,
          rate_limit_rpm: 60,
        } as never,
      ],
    } as never,
    provider,
  );

  assert.deepEqual(models[0]?.defaults?.capabilities, {
    streaming: true,
    toolCalling: true,
    roleplay: true,
  });
  assert.deepEqual(models[0]?.endpointPricing, {
    isFree: true,
    isPremium: false,
    requiredPlan: "Free",
    minPlanTier: 1,
    multiplier: 2,
  });
  assert.deepEqual(models[0]?.endpointMetadata, {
    object: "model",
    providerId: "grok-4.20-fast",
    routingGroup: "route:grok-4.20-fast",
    status: "healthy",
    type: "routing_group",
    poolSize: 0,
    rateLimitRpm: 120,
    responseBaseUrl: "https://blazeai.boxu.dev/api/",
  });
});

test("OpenAI-compatible parser tolerates BlazeAPI optional-field variants and malformed numeric hints", () => {
  const models = parseOpenAIModelsResponse(
    {
      base_url: "  https://blazeai.boxu.dev/api/  ",
      data: [
        {
          id: "qwen3.6-plus-search",
          object: "model",
          provider_id: "qwen3.6-plus",
          supports: { text: true, streaming: true, rp: false },
          status: " degraded ",
          type: "model",
          requiredPlan: "Team",
          min_plan_tier: null,
          minPlanTier: "tier-2",
          multiplier: -1,
          pool_size: "4",
          rateLimitRpm: Number.NaN,
          rate_limit_rpm: 90,
        } as never,
        {
          id: "image-only",
          supports: { text: false, imageGen: true, streaming: true, rp: true },
          status: "healthy",
        } as never,
      ],
    } as never,
    provider,
  );

  assert.deepEqual(models.map((entry) => entry.id), ["qwen3.6-plus-search"]);
  assert.deepEqual(models[0]?.defaults?.capabilities, {
    streaming: true,
  });
  assert.deepEqual(models[0]?.endpointPricing, {
    isFree: false,
    requiredPlan: "Team",
    minPlanTier: "tier-2",
  });
  assert.deepEqual(models[0]?.endpointMetadata, {
    object: "model",
    providerId: "qwen3.6-plus",
    status: "degraded",
    type: "model",
    rateLimitRpm: 90,
    responseBaseUrl: "https://blazeai.boxu.dev/api/",
  });
});

test("URL and discovery headers are built without mutating provider metadata", () => {
  assert.equal(buildUrl(provider.baseUrl, "models"), "http://127.0.0.1:8000/v1/models");
  const headers = buildDiscoveryHeaders(provider);
  assert.equal(headers.authorization, `Bearer ${TEST_API_KEY}`);
  assert.equal(headers["x-runtime"], "enabled");
  assert.equal(headers["x-discovery"], "enabled");
});


test("OpenAI context metadata uses effective server limits and ignores invalid values", () => {
  const cases = [
    { fields: { context_length: 1048576, max_model_len: 262144, meta: { context_length: 131072, model_max_tokens: 262144 } }, expected: 1048576 },
    { fields: { max_model_len: 262144 }, expected: 262144 },
    { fields: { meta: { context_length: 524288 } }, expected: 524288 },
    { fields: { context_length: "1048576" }, expected: 1048576 },
    { fields: { context_length: 0, max_model_len: 262144 }, expected: 262144 },
    { fields: { meta: { model_max_tokens: 262144 } }, expected: undefined },
  ];
  for (const { fields, expected } of cases) {
    const model = parseOpenAIModelsResponse({ data: [{ id: "mlx-chat", ...fields }] }, provider)[0]!;
    assert.equal(model.defaults?.contextWindow, expected);
    assert.equal(model.defaults?.maxTokens, undefined);
  }
  for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "", "invalid", null, true, {}, []]) {
    const model = parseOpenAIModelsResponse({ data: [{ id: "mlx-chat", context_length: value }] }, provider)[0]!;
    assert.equal(model.defaults?.contextWindow, undefined, String(value));
  }
});
