/**
 * Model Registry — maps AI task roles to OpenRouter model IDs.
 * All defaults use FREE models from OpenRouter.
 * Override any role via env vars: OPENROUTER_MODEL_<ROLE_UPPERCASE>
 *
 * Free model roster:
 *  nvidia/nemotron-3-ultra-550b-a55b:free   — 550B, best quality
 *  openai/gpt-oss-120b:free                 — GPT-style 120B, structured JSON
 *  openai/gpt-oss-20b:free                  — GPT-style 20B, fast extraction
 *  nvidia/nemotron-3-super-120b-a12b:free   — 120B Nvidia
 *  nvidia/nemotron-3-nano-30b-a3b:free      — 30B fast, cheap classify
 *  google/gemma-4-31b-it:free               — Gemma 31B instruction-tuned
 *  google/gemma-4-26b-a4b-it:free           — Gemma 26B sparse MoE, very fast
 *  poolside/laguna-m.1:free                 — Code-focused, medium
 *  poolside/laguna-xs.2:free                — Code-focused, small
 *  nex-agi/nex-n2-pro:free                  — General purpose
 *  meta-llama/llama-3.2-3b-instruct:free    — 3B, tiny fallback
 *  qwen/qwen3-coder:free                    — Qwen coder model
 */

export type ModelRole = 'classify' | 'extract' | 'complex' | 'rank' | 'nl' | 'fallback';

export interface ModelConfig {
  modelId: string;
  maxTokens: number;
  temperature: number;
  supportsJsonMode: boolean;
  description: string;
}

const DEFAULTS: Record<ModelRole, ModelConfig> = {
  // Fast yes/no classification — light model is fine
  classify: {
    modelId: 'google/gemma-4-26b-a4b-it:free',
    maxTokens: 256,
    temperature: 0.0,
    supportsJsonMode: false,
    description: 'Gemma 26B sparse MoE — fast job page classification'
  },
  // Structured JSON extraction — GPT-style model is best for JSON
  extract: {
    modelId: 'openai/gpt-oss-120b:free',
    maxTokens: 1500,
    temperature: 0.1,
    supportsJsonMode: true,
    description: 'GPT-OSS 120B — best free model for structured JSON extraction'
  },
  // Long / complex pages — use the biggest available model
  complex: {
    modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    maxTokens: 2000,
    temperature: 0.1,
    supportsJsonMode: false,
    description: 'Nemotron 550B — largest free model for complex/long pages'
  },
  // Match scoring — instruction-tuned, reasoning-capable
  rank: {
    modelId: 'google/gemma-4-31b-it:free',
    maxTokens: 512,
    temperature: 0.0,
    supportsJsonMode: false,
    description: 'Gemma 31B instruction-tuned — match & freshness scoring'
  },
  // NL query parsing — small fast model is sufficient
  nl: {
    modelId: 'google/gemma-4-26b-a4b-it:free',
    maxTokens: 512,
    temperature: 0.0,
    supportsJsonMode: false,
    description: 'Gemma 26B — natural language search query parsing'
  },
  // Fallback when primary fails — smallest reliable model
  fallback: {
    modelId: 'openai/gpt-oss-20b:free',
    maxTokens: 1200,
    temperature: 0.2,
    supportsJsonMode: false,
    description: 'GPT-OSS 20B — fast fallback when primary model fails'
  }
};

/**
 * Returns the ModelConfig for the given role.
 * Env vars OPENROUTER_MODEL_<ROLE_UPPERCASE> override the model ID.
 */
export function getModel(role: ModelRole): ModelConfig {
  const base = { ...DEFAULTS[role] };
  const envKey = `OPENROUTER_MODEL_${role.toUpperCase()}`;
  const override = process.env[envKey];
  if (override) {
    base.modelId = override;
    base.supportsJsonMode = override.includes('gpt-oss') || override.includes('gpt-4');
  }
  return base;
}

/** Returns true if an OpenRouter API key is configured */
export function isAiEnabled(): boolean {
  return !!(process.env.OPENROUTER_API_KEY?.trim());
}

/** All available FREE model IDs (for frontend model selector) */
export const AVAILABLE_MODELS = [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: '🟢 Nemotron Ultra 550B (Best Quality)' },
  { id: 'openai/gpt-oss-120b:free',               label: '🟢 GPT-OSS 120B (Best JSON)' },
  { id: 'openai/gpt-oss-20b:free',                label: '🟢 GPT-OSS 20B (Fast Extraction)' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: '🟢 Nemotron Super 120B' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free',    label: '🟢 Nemotron Nano 30B (Fast)' },
  { id: 'google/gemma-4-31b-it:free',             label: '🟢 Gemma 4 31B Instruct' },
  { id: 'google/gemma-4-26b-a4b-it:free',         label: '🟢 Gemma 4 26B MoE (Fastest)' },
  { id: 'poolside/laguna-m.1:free',               label: '🟢 Laguna M.1 (Code-focused)' },
  { id: 'poolside/laguna-xs.2:free',              label: '🟢 Laguna XS.2 (Lightweight)' },
  { id: 'nex-agi/nex-n2-pro:free',               label: '🟢 Nex N2 Pro' },
  { id: 'qwen/qwen3-coder:free',                  label: '🟢 Qwen3 Coder' },
  { id: 'meta-llama/llama-3.2-3b-instruct:free',  label: '🟢 Llama 3.2 3B (Tiny Fallback)' },
] as const;

/** Role → default model map (for frontend display) */
export const ROLE_DEFAULTS: Record<ModelRole, string> = {
  classify: DEFAULTS.classify.modelId,
  extract: DEFAULTS.extract.modelId,
  complex: DEFAULTS.complex.modelId,
  rank: DEFAULTS.rank.modelId,
  nl: DEFAULTS.nl.modelId,
  fallback: DEFAULTS.fallback.modelId,
};
