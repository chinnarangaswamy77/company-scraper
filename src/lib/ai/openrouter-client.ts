/**
 * OpenRouter AI Client
 * Single server-side gateway for all AI model calls.
 * Never import this from client-side code.
 */

export interface AiRequestOptions {
  systemPrompt: string;
  userContent: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** If true, attempt JSON mode (not all models support it) */
  jsonMode?: boolean;
}

export interface AiResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  /** Rough USD cost estimate based on public OpenRouter pricing */
  estimatedCostUsd: number;
  success: boolean;
  error?: string;
}

export interface ModelStatus {
  status: 'idle' | 'active' | 'rate_limited' | 'error' | 'disabled';
  lastChecked: string;
  error?: string;
  modelId: string;
}

// Global in-memory storage for model statuses
const modelStatuses: Record<string, ModelStatus> = {};

// Known models roster
const ALL_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'poolside/laguna-m.1:free',
  'poolside/laguna-xs.2:free',
  'nex-agi/nex-n2-pro:free',
  'qwen/qwen3-coder:free',
  'meta-llama/llama-3.2-3b-instruct:free'
];

export function initModelStatuses() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const initialStatus = apiKey ? 'idle' : 'disabled';
  for (const m of ALL_MODELS) {
    if (!modelStatuses[m]) {
      modelStatuses[m] = {
        status: initialStatus,
        lastChecked: new Date().toISOString(),
        modelId: m
      };
    }
  }
}

export function getModelStatuses(): Record<string, ModelStatus> {
  initModelStatuses();
  return modelStatuses;
}

export function updateModelStatus(modelId: string, status: ModelStatus['status'], error?: string) {
  modelStatuses[modelId] = {
    status,
    lastChecked: new Date().toISOString(),
    error,
    modelId
  };
}

// Approximate cost per 1M tokens (input+output blended) for common models
const COST_PER_1M: Record<string, number> = {
  'google/gemini-flash-1.5': 0.075,
  'openai/gpt-4o-mini': 0.15,
  'anthropic/claude-3-haiku': 0.25,
  'meta-llama/llama-3-8b-instruct': 0.06,
  'google/gemini-pro-1.5': 3.5,
  'openai/gpt-4o': 5.0,
  'anthropic/claude-3-5-sonnet': 3.0,
};

function estimateCost(model: string, totalTokens: number): number {
  const rate = COST_PER_1M[model] ?? 0.5; // conservative unknown fallback
  return (totalTokens / 1_000_000) * rate;
}

/**
 * Sanitises page HTML before sending to AI:
 * - Strips scripts, styles, nav, footer
 * - Decodes HTML entities
 * - Collapses whitespace
 * - Truncates to maxChars
 */
export function sanitiseHtmlForAi(html: string, maxChars = 8000): string {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')       // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return clean.slice(0, maxChars);
}

/**
 * Makes a completion call to OpenRouter.
 * Returns a typed AiResponse — never throws; errors are captured in .error.
 */
/**
 * Makes a completion call to OpenRouter.
 * Returns a typed AiResponse — never throws; errors are captured in .error.
 */
export async function callOpenRouter(opts: AiRequestOptions): Promise<AiResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    updateModelStatus(opts.model, 'disabled', 'OPENROUTER_API_KEY is not set');
    return {
      content: '',
      model: opts.model,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
      estimatedCostUsd: 0,
      success: false,
      error: 'OPENROUTER_API_KEY is not set'
    };
  }

  const t0 = Date.now();
  let attempts = 0;
  const maxAttempts = 3;
  let delay = 2000; // Start with 2 seconds backoff

  while (true) {
    attempts++;
    try {
      const messages: { role: string; content: string }[] = [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userContent }
      ];

      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.1,
      };

      // Enable JSON mode for models that support it
      if (opts.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://jobradar.india',
          'X-Title': 'JobRadar India'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });

      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        console.error(`[OpenRouter] ${opts.model} HTTP ${res.status}: ${errText} (attempt ${attempts}/${maxAttempts})`);

        const isRateLimited = 
          res.status === 429 || 
          errText.toLowerCase().includes('rate limit') || 
          errText.toLowerCase().includes('quota') || 
          errText.toLowerCase().includes('rate-limited') || 
          errText.toLowerCase().includes('429');

        if (isRateLimited && attempts < maxAttempts) {
          // Parse retry after header or error message body if present
          let waitTime = delay;
          const retryAfterHeader = res.headers.get('retry-after');
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed)) waitTime = parsed * 1000;
          } else {
            const retryAfterMatch = errText.match(/"retry_after_seconds"\s*:\s*([0-9.]+)/i);
            if (retryAfterMatch && retryAfterMatch[1]) {
              waitTime = parseFloat(retryAfterMatch[1]) * 1000;
            }
          }
          console.warn(`[OpenRouter] Rate limited (HTTP ${res.status}). Retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          delay *= 2;
          continue;
        }

        updateModelStatus(opts.model, isRateLimited ? 'rate_limited' : 'error', `HTTP ${res.status}: ${errText}`);

        return {
          content: '',
          model: opts.model,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs,
          estimatedCostUsd: 0,
          success: false,
          error: `HTTP ${res.status}: ${errText}`
        };
      }

      const data = await res.json();
      
      // Some providers via OpenRouter may return 200 OK but embed a provider-level error inside choices or error field
      if (data.error) {
        const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        console.error(`[OpenRouter] ${opts.model} returned error payload: ${errMsg} (attempt ${attempts}/${maxAttempts})`);
        
        const isRateLimited = 
          errMsg.toLowerCase().includes('rate limit') || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate-limited') || 
          errMsg.toLowerCase().includes('429');

        if (isRateLimited && attempts < maxAttempts) {
          let waitTime = delay;
          const retryAfterMatch = errMsg.match(/retry_after_seconds"\s*:\s*([0-9.]+)/i) || errMsg.match(/retry after\s*([0-9.]+)\s*s/i);
          if (retryAfterMatch && retryAfterMatch[1]) {
            waitTime = parseFloat(retryAfterMatch[1]) * 1000;
          }
          console.warn(`[OpenRouter] Rate limited by provider. Retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          delay *= 2;
          continue;
        }

        updateModelStatus(opts.model, isRateLimited ? 'rate_limited' : 'error', `Payload Error: ${errMsg}`);
        return {
          content: '',
          model: opts.model,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs,
          estimatedCostUsd: 0,
          success: false,
          error: `Payload Error: ${errMsg}`
        };
      }

      const content: string = data.choices?.[0]?.message?.content ?? '';
      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      };

      const estimatedCostUsd = estimateCost(opts.model, usage.totalTokens);

      console.log(
        `[OpenRouter] ✅ ${opts.model} | ${latencyMs}ms | ${usage.totalTokens} tokens | ~$${estimatedCostUsd.toFixed(5)}`
      );

      updateModelStatus(opts.model, 'active');

      return { content, model: opts.model, usage, latencyMs, estimatedCostUsd, success: true };
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      console.error(`[OpenRouter] ❌ ${opts.model} failed on attempt ${attempts}/${maxAttempts}:`, err.message);

      const isRateLimited = 
        err.message.toLowerCase().includes('429') || 
        err.message.toLowerCase().includes('rate limit') ||
        err.message.toLowerCase().includes('quota');

      if (isRateLimited && attempts < maxAttempts) {
        console.warn(`[OpenRouter] Rate limited (Exception). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      updateModelStatus(opts.model, isRateLimited ? 'rate_limited' : 'error', err.message);

      return {
        content: '',
        model: opts.model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs,
        estimatedCostUsd: 0,
        success: false,
        error: err.message
      };
    }
  }
}

/**
 * Parses the first JSON object from an AI response string.
 * Handles markdown code fences, trailing commas, and common model quirks.
 */
export function parseAiJson<T = Record<string, unknown>>(content: string): T | null {
  if (!content) return null;

  // Strip markdown code fences
  let raw = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Find first { ... }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  raw = raw.slice(start, end + 1);

  // Remove trailing commas before } or ]
  raw = raw.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

