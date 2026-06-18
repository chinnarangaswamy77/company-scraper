/**
 * AI Job Extraction Pipeline
 *
 * Stage 1: Classify — is this a job page?
 * Stage 2: Extract  — pull structured job data
 * Stage 3: Validate — schema check + normalize
 * Stage 4: Fallback — retry with complex/fallback model if confidence is low
 * Stage 5: Score    — match + freshness scoring
 */

import { callOpenRouter, parseAiJson, sanitiseHtmlForAi } from './openrouter-client';
import { getModel, isAiEnabled } from './model-registry';
import {
  CLASSIFY_SYSTEM_PROMPT, buildClassifyPrompt,
  EXTRACT_SYSTEM_PROMPT, buildExtractPrompt,
} from './prompts';
import { validateAiJobSchema, aiJobToScrapedJobFields, type AiJobSchema, type ConfidenceTier, type AiExtractResult } from './validator';
import { getCachedExtraction, setCachedExtraction, isUrlCached } from './url-cache';
import { loadCandidateProfile } from './candidate-profile';
import { scoreJob, computeFreshnessScore } from './ranker';


interface ClassifyResponse {
  is_job_page: boolean;
  confidence: number;
  source_type?: string;
  reason?: string;
}

const CONFIDENCE_HIGH = 0.75;
const CONFIDENCE_MEDIUM = 0.45;

function getTier(confidence: number): ConfidenceTier {
  if (confidence >= CONFIDENCE_HIGH) return 'high';
  if (confidence >= CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}

/** Fetch raw HTML for a URL with a realistic browser User-Agent */
async function fetchPageHtml(url: string, timeoutMs = 12000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/**
 * Classify whether a page is a specific job posting.
 * Uses the 'classify' model (fast, cheap).
 */
async function classifyPage(url: string, textContent: string): Promise<{ isJob: boolean; confidence: number; modelUsed: string; latencyMs: number }> {
  const model = getModel('classify');
  const resp = await callOpenRouter({
    systemPrompt: CLASSIFY_SYSTEM_PROMPT,
    userContent: buildClassifyPrompt(url, textContent.slice(0, 3000)),
    model: model.modelId,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
  });

  if (!resp.success) {
    return { isJob: false, confidence: 0, modelUsed: model.modelId, latencyMs: resp.latencyMs };
  }

  const parsed = parseAiJson<ClassifyResponse>(resp.content);
  if (!parsed) {
    return { isJob: false, confidence: 0, modelUsed: model.modelId, latencyMs: resp.latencyMs };
  }

  return {
    isJob: !!parsed.is_job_page,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    modelUsed: resp.model,
    latencyMs: resp.latencyMs,
  };
}

/**
 * Extract structured job data using the 'extract' model.
 * Falls back to 'complex' then 'fallback' if extraction fails or confidence is low.
 */
async function extractJobData(
  url: string,
  textContent: string,
  preferComplex = false
): Promise<{ raw: unknown; modelUsed: string; latencyMs: number } | null> {
  const roles = preferComplex
    ? (['complex', 'extract', 'fallback'] as const)
    : (['extract', 'complex', 'fallback'] as const);

  let totalLatency = 0;

  for (const role of roles) {
    const model = getModel(role);
    const resp = await callOpenRouter({
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      userContent: buildExtractPrompt(url, textContent),
      model: model.modelId,
      maxTokens: model.maxTokens,
      temperature: model.temperature,
      jsonMode: model.supportsJsonMode,
    });

    totalLatency += resp.latencyMs;

    if (!resp.success) {
      console.warn(`[AIExtractor] ${role} model (${model.modelId}) failed: ${resp.error}`);
      continue;
    }

    const raw = parseAiJson(resp.content);
    if (raw) {
      return { raw, modelUsed: resp.model, latencyMs: totalLatency };
    }

    console.warn(`[AIExtractor] ${role} model returned unparseable JSON, trying next model...`);
  }

  return null;
}

/**
 * Full AI extraction pipeline for a single URL.
 * Checks cache, fetches HTML, classifies, extracts, validates, scores.
 */
export async function aiExtractJob(
  url: string,
  providedHtml?: string,
  options: { skipClassify?: boolean; confidenceThreshold?: number } = {}
): Promise<AiExtractResult> {
  const t0 = Date.now();

  if (!isAiEnabled()) {
    return {
      success: false, isJobPage: false, confidence: 0, tier: 'rejected',
      reviewNeeded: false, job: null, scrapedJobFields: null,
      matchScore: 0, freshnessScore: 0, compositeScore: 0,
      skillMatches: [], skillGaps: [], matchExplanation: '',
      aiRanked: false, modelUsed: 'none', latencyMs: 0,
      error: 'AI not enabled — set OPENROUTER_API_KEY'
    };
  }

  // Check cache
  if (isUrlCached(url)) {
    const cached = getCachedExtraction(url);
    if (cached) {
      console.log(`[AIExtractor] Cache hit: ${url}`);
      return cached;
    }
  }

  const minConfidence = options.confidenceThreshold ?? CONFIDENCE_MEDIUM;

  try {
    // Fetch HTML if not provided
    let html = providedHtml ?? '';
    if (!html) {
      try {
        html = await fetchPageHtml(url);
      } catch (fetchErr: any) {
        return {
          success: false, isJobPage: false, confidence: 0, tier: 'rejected',
          reviewNeeded: false, job: null, scrapedJobFields: null,
          matchScore: 0, freshnessScore: 0, compositeScore: 0,
          skillMatches: [], skillGaps: [], matchExplanation: '',
          aiRanked: false, modelUsed: 'none', latencyMs: Date.now() - t0,
          error: `Fetch failed: ${fetchErr.message}`
        };
      }
    }

    // Sanitize HTML for AI consumption
    const textContent = sanitiseHtmlForAi(html, 8000);
    if (textContent.length < 50) {
      return {
        success: false, isJobPage: false, confidence: 0, tier: 'rejected',
        reviewNeeded: false, job: null, scrapedJobFields: null,
        matchScore: 0, freshnessScore: 0, compositeScore: 0,
        skillMatches: [], skillGaps: [], matchExplanation: '',
        aiRanked: false, modelUsed: 'none', latencyMs: Date.now() - t0,
        error: 'Page content too short to extract'
      };
    }

    let modelUsed = '';
    let totalLatency = 0;

    // Stage 1: Classify (skip for known ATS URLs)
    let classifyConfidence = 0.8; // assume job page for known ATS domains
    const isKnownAts = /lever\.co|greenhouse\.io|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|bamboohr\.com/.test(url);

    if (!options.skipClassify && !isKnownAts) {
      const classify = await classifyPage(url, textContent);
      modelUsed = classify.modelUsed;
      totalLatency += classify.latencyMs;

      if (!classify.isJob || classify.confidence < 0.3) {
        const result: AiExtractResult = {
          success: false, isJobPage: false, confidence: classify.confidence, tier: 'rejected',
          reviewNeeded: false, job: null, scrapedJobFields: null,
          matchScore: 0, freshnessScore: 0, compositeScore: 0,
          skillMatches: [], skillGaps: [], matchExplanation: '',
          aiRanked: false, modelUsed: classify.modelUsed, latencyMs: Date.now() - t0
        };
        setCachedExtraction(url, result);
        return result;
      }
      classifyConfidence = classify.confidence;
    }

    // Stage 2: Extract — use complex model for low classify confidence
    const preferComplex = classifyConfidence < 0.65;
    const extracted = await extractJobData(url, textContent, preferComplex);

    if (!extracted) {
      const result: AiExtractResult = {
        success: false, isJobPage: true, confidence: classifyConfidence, tier: 'low',
        reviewNeeded: true, job: null, scrapedJobFields: null,
        matchScore: 0, freshnessScore: 0, compositeScore: 0,
        skillMatches: [], skillGaps: [],
        matchExplanation: 'Extraction failed — all models returned invalid JSON',
        aiRanked: false, modelUsed, latencyMs: Date.now() - t0,
        error: 'All extraction models failed'
      };
      return result;
    }

    modelUsed = extracted.modelUsed;
    totalLatency += extracted.latencyMs;

    // Stage 3: Validate
    const validation = validateAiJobSchema(extracted.raw, url);

    if (!validation.valid || !validation.job) {
      const result: AiExtractResult = {
        success: false, isJobPage: true, confidence: classifyConfidence, tier: 'low',
        reviewNeeded: true, job: null, scrapedJobFields: null,
        matchScore: 0, freshnessScore: 0, compositeScore: 0,
        skillMatches: [], skillGaps: [],
        matchExplanation: `Validation failed: ${validation.errors.join(', ')}`,
        aiRanked: false, modelUsed, latencyMs: Date.now() - t0,
        error: validation.errors.join(', ')
      };
      return result;
    }

    const job = validation.job;
    const confidence = job.confidence;
    const tier = getTier(confidence);
    const reviewNeeded = confidence < CONFIDENCE_HIGH || tier === 'medium';

    // Stage 4: Score
    const profile = loadCandidateProfile();
    const scoring = await scoreJob(job, profile).catch(() => ({
      matchScore: computeFreshnessScore(job.posted_date),
      freshnessScore: 50,
      compositeScore: 50,
      skillMatches: [],
      skillGaps: [],
      explanation: 'Scoring unavailable',
      ai_ranked: false,
    }));

    // Build merged fields for ScrapedJob
    const scrapedJobFields = {
      ...aiJobToScrapedJobFields(job),
      match_score: scoring.matchScore,
      freshness_score: scoring.freshnessScore,
      composite_score: scoring.compositeScore,
      ai_model_used: modelUsed,
      review_needed: reviewNeeded,
    };

    const result: AiExtractResult = {
      success: true,
      isJobPage: true,
      confidence,
      tier,
      reviewNeeded,
      job,
      scrapedJobFields,
      matchScore: scoring.matchScore,
      freshnessScore: scoring.freshnessScore,
      compositeScore: scoring.compositeScore,
      skillMatches: scoring.skillMatches,
      skillGaps: scoring.skillGaps,
      matchExplanation: scoring.explanation,
      aiRanked: scoring.ai_ranked,
      modelUsed,
      latencyMs: Date.now() - t0,
    };

    // Cache successful results
    setCachedExtraction(url, result);

    console.log(
      `[AIExtractor] ✨ ${job.job_title} @ ${job.company_name} | ` +
      `conf: ${confidence.toFixed(2)} | match: ${scoring.matchScore} | ` +
      `${modelUsed} | ${Date.now() - t0}ms`
    );

    return result;

  } catch (err: any) {
    console.error('[AIExtractor] Unexpected error:', err.message);
    return {
      success: false, isJobPage: false, confidence: 0, tier: 'rejected',
      reviewNeeded: false, job: null, scrapedJobFields: null,
      matchScore: 0, freshnessScore: 0, compositeScore: 0,
      skillMatches: [], skillGaps: [], matchExplanation: '',
      aiRanked: false, modelUsed: 'none', latencyMs: Date.now() - t0,
      error: err.message
    };
  }
}

/**
 * Batch-enrich an array of existing job records using AI.
 * Processes in batches of 4 with 300ms spacing to avoid rate limits.
 * Calls onProgress with each result as it comes in.
 */
export async function batchAiEnrich(
  jobs: Array<{ job_url: string; job_id: string; [key: string]: unknown }>,
  onProgress?: (jobId: string, result: AiExtractResult) => void,
  batchSize = 4
): Promise<Map<string, AiExtractResult>> {
  const results = new Map<string, AiExtractResult>();
  if (!isAiEnabled()) return results;

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);

    await Promise.allSettled(
      batch.map(async (job) => {
        try {
          const result = await aiExtractJob(job.job_url);
          results.set(job.job_id, result);
          if (onProgress) onProgress(job.job_id, result);
        } catch (err: any) {
          console.error(`[BatchEnrich] Failed for ${job.job_url}: ${err.message}`);
        }
      })
    );

    if (i + batchSize < jobs.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

/**
 * Optimizes raw HTML content by removing scripts, style sheets, inline SVG components,
 * and normalizing spacing to drastically reduce input tokens before AI parsing.
 */
export function cleanHtmlForAi(rawHtml: string): string {
  if (!rawHtml) return '';
  return rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // strip scripts
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')   // strip styles
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')         // strip SVGs
    .replace(/<path\b[^<]*\/>/gi, '')
    .replace(/\s+/g, ' ')                                              // normalize spaces
    .trim();
}

/**
 * Entry point for optimized queue worker extraction. Uses HTML clean-up
 * and fallback model routing chain.
 */
export async function optimizedAiExtract(url: string, rawHtml: string) {
  const cleanedHtml = cleanHtmlForAi(rawHtml);
  const result = await aiExtractJob(url, cleanedHtml);
  if (result.success && result.scrapedJobFields) {
    return { success: true, data: result.scrapedJobFields };
  }
  return { success: false, reason: result.error || 'AI extraction stage failed' };
}

