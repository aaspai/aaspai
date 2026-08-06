/**
 * Cost calculation for provider token usage.
 *
 * Logic adapted from the AI Observer reference (MIT licensed) —
 * https://github.com/tobilg/ai-observer (see study/AI-OBSERVER-PARITY-IMPLEMENTATION-AND-VERIFICATION-PLAN.md).
 * Pricing data files in `./pricing-data` are copied from the reference
 * `backend/internal/pricing/data` and remain under the reference's
 * MIT license.
 *
 * Decimal safety: costs are summed in integer microdollars (USD × 1e6)
 * so the totals do not accumulate floating-point rounding defects.
 * Unknown models return `null` — never a fabricated zero.
 */

import claudeData from "./pricing-data/claude.json";
import codexData from "./pricing-data/codex.json";
import geminiData from "./pricing-data/gemini.json";

export interface ModelPricing {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheReadCostPerMTok: number;
  cacheWriteCostPerMTok: number;
  deprecated: boolean;
}

interface ModelEntryJson {
  aliases?: string[];
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheReadCostPerMTok?: number;
  cacheWriteCostPerMTok?: number;
  deprecated?: boolean;
}

interface PricingFile {
  provider: string;
  lastUpdated: string;
  models: Record<string, ModelEntryJson>;
}

export type ProviderName = "claude" | "codex" | "gemini";

class PricingTable {
  readonly version: string;
  private readonly models = new Map<string, ModelPricing>();
  private readonly aliases = new Map<string, string>();

  constructor(file: PricingFile) {
    this.version = file.lastUpdated;
    for (const [name, entry] of Object.entries(file.models)) {
      this.models.set(name, this.toPricing(entry));
      for (const alias of entry.aliases ?? []) {
        if (alias && alias !== name) this.aliases.set(alias, name);
      }
    }
  }

  private toPricing(entry: ModelEntryJson): ModelPricing {
    return {
      inputCostPerMTok: entry.inputCostPerMTok,
      outputCostPerMTok: entry.outputCostPerMTok,
      cacheReadCostPerMTok: entry.cacheReadCostPerMTok ?? 0,
      cacheWriteCostPerMTok: entry.cacheWriteCostPerMTok ?? 0,
      deprecated: entry.deprecated ?? false,
    };
  }

  /** Resolve a model name to pricing, applying alias normalization. */
  get(model: string): ModelPricing | null {
    const trimmed = model.trim();
    if (!trimmed) return null;
    const direct = this.models.get(trimmed);
    if (direct) return direct;
    const canonical = this.aliases.get(trimmed);
    if (canonical) return this.models.get(canonical) ?? null;
    return null;
  }
}

const claudeTable = new PricingTable(claudeData as PricingFile);
const codexTable = new PricingTable(codexData as PricingFile);
const geminiTable = new PricingTable(geminiData as PricingFile);

export const PRICING_VERSIONS = {
  claude: claudeTable.version,
  codex: codexTable.version,
  gemini: geminiTable.version,
} as const;

export function normalizeModel(provider: ProviderName, model: string): string {
  let trimmed = model.trim();
  if (provider === "claude" && trimmed.startsWith("anthropic/")) {
    trimmed = trimmed.slice("anthropic/".length);
  }
  if (provider === "codex" && trimmed.startsWith("openai/")) {
    trimmed = trimmed.slice("openai/".length);
  }
  return trimmed;
}

function usdToMicroDollars(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export interface ClaudeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Cost in USD or null when the model is not in the pricing table. */
export function calculateClaudeCost(model: string, usage: ClaudeTokenUsage): number | null {
  const pricing = claudeTable.get(normalizeModel("claude", model));
  if (!pricing) return null;

  const micro =
    usdToMicroDollars(Math.max(0, usage.inputTokens) * (pricing.inputCostPerMTok / 1e6)) +
    usdToMicroDollars(Math.max(0, usage.outputTokens) * (pricing.outputCostPerMTok / 1e6)) +
    usdToMicroDollars(
      Math.max(0, usage.cacheCreationInputTokens) * (pricing.cacheWriteCostPerMTok / 1e6),
    ) +
    usdToMicroDollars(
      Math.max(0, usage.cacheReadInputTokens) * (pricing.cacheReadCostPerMTok / 1e6),
    );
  return micro / 1e6;
}

export type ClaudePricingMode = "auto" | "calculate" | "display";

/**
 * Cost with pricing mode, matching the reference `GetClaudeCostWithMode`.
 * `auto` prefers the provider-reported costUSD and falls back to
 * calculation; unknown pricing returns 0 only in `display` mode, else
 * falls back to calculated (which may be null → 0).
 */
export function getClaudeCostWithMode(
  mode: ClaudePricingMode,
  model: string,
  usage: ClaudeTokenUsage,
  costUsd: number | null | undefined,
): number {
  switch (mode) {
    case "display":
      return costUsd && costUsd > 0 ? costUsd : 0;
    case "calculate":
      return calculateClaudeCost(model, usage) ?? 0;
    default:
      if (costUsd && costUsd > 0) return costUsd;
      return calculateClaudeCost(model, usage) ?? 0;
  }
}

/** Cost in USD or null when the model is not in the pricing table. */
export function calculateCodexCost(
  model: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
): number | null {
  const pricing = codexTable.get(normalizeModel("codex", model));
  if (!pricing) return null;

  const input = Math.max(0, inputTokens);
  const cached = Math.min(Math.max(0, cachedTokens), input);
  const nonCached = input - cached;
  const output = Math.max(0, outputTokens);

  const micro =
    usdToMicroDollars(nonCached * (pricing.inputCostPerMTok / 1e6)) +
    usdToMicroDollars(cached * (pricing.cacheReadCostPerMTok / 1e6)) +
    usdToMicroDollars(output * (pricing.outputCostPerMTok / 1e6));
  return micro / 1e6;
}

export const GEMINI_TOKEN_TYPES = ["input", "output", "cache", "thought", "tool"] as const;
export type GeminiTokenType = (typeof GEMINI_TOKEN_TYPES)[number];

/** Cost for a single Gemini token type, or null when unpriced/unknown. */
export function calculateGeminiCostForTokenType(
  model: string,
  tokenType: string,
  tokenCount: number,
): number | null {
  const pricing = geminiTable.get(normalizeModel("gemini", model));
  if (!pricing) return null;
  if (tokenCount <= 0) return null;

  const tokens = Math.max(0, tokenCount);
  let usd: number | null;
  if (tokenType === "input") {
    usd = tokens * (pricing.inputCostPerMTok / 1e6);
  } else if (tokenType === "output" || tokenType === "thought") {
    usd = tokens * (pricing.outputCostPerMTok / 1e6);
  } else if (tokenType === "cache") {
    usd = tokens * (pricing.cacheReadCostPerMTok / 1e6);
  } else {
    usd = null;
  }
  if (usd === null) return null;
  return usdToMicroDollars(usd) / 1e6;
}

/** Total Gemini cost or null when the model is unpriced. */
export function calculateGeminiCost(
  model: string,
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
): number | null {
  const parts = [
    calculateGeminiCostForTokenType(model, "input", inputTokens),
    calculateGeminiCostForTokenType(model, "cache", cachedTokens),
    calculateGeminiCostForTokenType(model, "output", outputTokens),
  ];
  const known = parts.filter((p): p is number => p !== null);
  if (known.length === 0) return null;
  return roundUsd(known.reduce((sum, p) => sum + p, 0));
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** True when the model is present in any pricing table. */
export function isKnownModel(provider: ProviderName, model: string): boolean {
  const table =
    provider === "claude" ? claudeTable : provider === "codex" ? codexTable : geminiTable;
  return table.get(normalizeModel(provider, model)) !== null;
}
