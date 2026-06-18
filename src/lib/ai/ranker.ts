/**
 * Match Scoring & Job Ranking
 *
 * Two scoring modes:
 *  1. AI-powered: calls the rank model via OpenRouter
 *  2. Heuristic fallback: fast local scoring when AI is unavailable
 */

import { callOpenRouter, parseAiJson } from './openrouter-client';
import { getModel, isAiEnabled } from './model-registry';
import { buildRankPrompt, RANK_SYSTEM_PROMPT } from './prompts';
import type { CandidateProfile } from './candidate-profile';
import type { AiJobSchema } from './validator';

export interface ScoredJob<T = Record<string, unknown>> {
  job: T;
  matchScore: number;
  freshnessScore: number;
  compositeScore: number;
  skillMatches: string[];
  skillGaps: string[];
  explanation: string;
  ai_ranked: boolean;
}

interface AiRankResponse {
  match_score: number;
  skill_matches: string[];
  skill_gaps: string[];
  explanation: string;
}

// ─── Heuristic match scorer (no AI needed) ────────────────────────────────────
export function heuristicMatchScore(
  job: { job_title: string; location: string; skills?: string[]; experience_required?: string; work_mode?: string },
  profile: CandidateProfile
): { score: number; skillMatches: string[]; skillGaps: string[] } {
  let score = 0;
  const jobSkills = (job.skills || []).map(s => s.toLowerCase());
  const profileSkills = profile.skills.map(s => s.toLowerCase());

  // Skills (40 pts)
  const skillMatches = profile.skills.filter(s => jobSkills.includes(s.toLowerCase()));
  const skillGaps = (job.skills || []).filter(s => !profileSkills.includes(s.toLowerCase()));
  const skillRatio = jobSkills.length > 0 ? skillMatches.length / Math.min(jobSkills.length, 6) : 0;
  score += Math.round(skillRatio * 40);

  // Role alignment (25 pts)
  const titleLower = job.job_title.toLowerCase();
  const roleMatch = profile.preferred_roles.some(r => titleLower.includes(r.toLowerCase().split(' ')[0]));
  if (roleMatch) score += 25;
  else if (/(developer|engineer|analyst|designer|manager)/i.test(titleLower)) score += 10;

  // Location (20 pts)
  const locLower = job.location.toLowerCase();
  if (job.work_mode === 'remote' || locLower.includes('remote')) {
    score += profile.remote_ok ? 20 : 5;
  } else {
    const cityMatch = profile.preferred_cities.some(c => locLower.includes(c.toLowerCase()));
    if (cityMatch) score += 20;
    else if (locLower.includes('india')) score += 8;
  }

  // Experience (15 pts)
  if (job.experience_required) {
    const expMatch = job.experience_required.match(/(\d+)\s*[-–to]+\s*(\d+)/);
    if (expMatch) {
      const min = parseInt(expMatch[1]);
      const max = parseInt(expMatch[2]);
      if (profile.experience_years >= min && profile.experience_years <= max) score += 15;
      else if (profile.experience_years >= min) score += 8;
    }
  } else {
    score += 10; // no requirement = good
  }

  return { score: Math.min(100, score), skillMatches, skillGaps };
}

// ─── AI match scorer ──────────────────────────────────────────────────────────
async function aiMatchScore(
  job: AiJobSchema,
  profile: CandidateProfile
): Promise<{ score: number; skillMatches: string[]; skillGaps: string[]; explanation: string } | null> {
  if (!isAiEnabled()) return null;

  const model = getModel('rank');
  const userContent = buildRankPrompt(
    job.job_title,
    job.location,
    job.skills,
    job.experience_min_years,
    job.experience_max_years,
    job.description,
    profile
  );

  const resp = await callOpenRouter({
    systemPrompt: RANK_SYSTEM_PROMPT,
    userContent,
    model: model.modelId,
    maxTokens: model.maxTokens,
    temperature: model.temperature,
  });

  if (!resp.success) return null;

  const parsed = parseAiJson<AiRankResponse>(resp.content);
  if (!parsed || typeof parsed.match_score !== 'number') return null;

  return {
    score: Math.min(100, Math.max(0, Math.round(parsed.match_score))),
    skillMatches: Array.isArray(parsed.skill_matches) ? parsed.skill_matches : [],
    skillGaps: Array.isArray(parsed.skill_gaps) ? parsed.skill_gaps : [],
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
  };
}

// ─── Freshness scorer ─────────────────────────────────────────────────────────
export function computeFreshnessScore(postedDate: string | null): number {
  if (!postedDate) return 50; // unknown date gets middle score

  const now = Date.now();
  let ts: number;

  // Handle relative dates like "2 days ago"
  const relMatch = postedDate.match(/(\d+)\s*(minute|hour|day|week|month)/i);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const msMap: Record<string, number> = {
      minute: 60_000, hour: 3_600_000, day: 86_400_000,
      week: 604_800_000, month: 2_592_000_000
    };
    ts = now - n * (msMap[unit] ?? 86_400_000);
  } else {
    ts = Date.parse(postedDate);
    if (isNaN(ts)) return 50;
  }

  const ageMs = now - ts;
  const ageDays = ageMs / 86_400_000;

  if (ageDays <= 1) return 100;
  if (ageDays <= 3) return 90;
  if (ageDays <= 7) return 75;
  if (ageDays <= 14) return 55;
  if (ageDays <= 30) return 35;
  if (ageDays <= 60) return 15;
  return 5;
}

// ─── Main ranking function ────────────────────────────────────────────────────
export async function scoreJob(
  job: AiJobSchema,
  profile: CandidateProfile
): Promise<{ matchScore: number; freshnessScore: number; compositeScore: number; skillMatches: string[]; skillGaps: string[]; explanation: string; ai_ranked: boolean }> {
  const freshness = computeFreshnessScore(job.posted_date);

  // Try AI scoring first
  const aiResult = await aiMatchScore(job, profile).catch(() => null);

  if (aiResult) {
    const composite = Math.round(aiResult.score * 0.6 + freshness * 0.4);
    return {
      matchScore: aiResult.score,
      freshnessScore: freshness,
      compositeScore: composite,
      skillMatches: aiResult.skillMatches,
      skillGaps: aiResult.skillGaps,
      explanation: aiResult.explanation,
      ai_ranked: true,
    };
  }

  // Heuristic fallback
  const h = heuristicMatchScore(
    { job_title: job.job_title, location: job.location, skills: job.skills, work_mode: job.work_mode },
    profile
  );
  const composite = Math.round(h.score * 0.6 + freshness * 0.4);

  return {
    matchScore: h.score,
    freshnessScore: freshness,
    compositeScore: composite,
    skillMatches: h.skillMatches,
    skillGaps: h.skillGaps,
    explanation: `Heuristic score: ${h.score}/100 skills match, ${freshness}/100 freshness.`,
    ai_ranked: false,
  };
}

/**
 * Quick heuristic scorer for non-AI-extracted jobs (existing ScrapedJob records).
 * Used to add match_score + freshness_score to existing DB records.
 */
export function scoreExistingJob(
  job: { job_title: string; location: string; skills?: string[]; experience_required?: string; work_mode?: string; posted_date?: string },
  profile: CandidateProfile
): { matchScore: number; freshnessScore: number; compositeScore: number } {
  const h = heuristicMatchScore(job, profile);
  const freshness = computeFreshnessScore(job.posted_date || null);
  return {
    matchScore: h.score,
    freshnessScore: freshness,
    compositeScore: Math.round(h.score * 0.6 + freshness * 0.4),
  };
}
