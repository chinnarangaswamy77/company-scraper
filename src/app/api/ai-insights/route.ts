import { NextRequest, NextResponse } from 'next/server';
import { isAiEnabled } from '@/lib/ai/model-registry';
import { callOpenRouter, parseAiJson } from '@/lib/ai/openrouter-client';
import { INSIGHTS_SYSTEM_PROMPT, buildInsightsPrompt } from '@/lib/ai/prompts';
import { getModel } from '@/lib/ai/model-registry';
import { dbLoadJobs, isPgAvailable } from '@/lib/db';
import { loadJobState } from '@/lib/job-scraper';

export interface AiInsights {
  top_hiring_companies: { name: string; count: number }[];
  trending_skills: { skill: string; count: number }[];
  fastest_growing_roles: { role: string; count: number }[];
  top_cities: { city: string; count: number }[];
  remote_first_companies: string[];
  new_jobs_last_hour: number;
  total_jobs_analyzed: number;
  generated_at: string;
  ai_powered: boolean;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
let insightsCache: { data: AiInsights; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Heuristic insights (no AI needed) ───────────────────────────────────────
function computeHeuristicInsights(jobs: any[]): AiInsights {
  const companyCounts = new Map<string, number>();
  const skillCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const cityCounts = new Map<string, number>();
  const remoteCompanies = new Set<string>();

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let newLastHour = 0;

  for (const job of jobs) {
    // Companies
    const co = job.company_name || 'Unknown';
    companyCounts.set(co, (companyCounts.get(co) || 0) + 1);

    // Skills
    for (const skill of (job.skills || [])) {
      skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
    }

    // Roles — normalize to first 2 words
    const roleKey = (job.job_title || '').split(/\s+/).slice(0, 2).join(' ');
    if (roleKey) roleCounts.set(roleKey, (roleCounts.get(roleKey) || 0) + 1);

    // Cities
    const city = job.city || (job.location || '').split(',')[0].trim();
    if (city && city !== 'India') cityCounts.set(city, (cityCounts.get(city) || 0) + 1);

    // Remote companies
    if (job.work_mode === 'remote') remoteCompanies.add(co);

    // New last hour
    const ts = job.first_seen_timestamp || job.scrapedAt || '';
    if (ts && Date.parse(ts) > oneHourAgo) newLastHour++;
  }

  const sortMap = (m: Map<string, number>, topN: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

  return {
    top_hiring_companies: sortMap(companyCounts, 5).map(([name, count]) => ({ name, count })),
    trending_skills: sortMap(skillCounts, 8).map(([skill, count]) => ({ skill, count })),
    fastest_growing_roles: sortMap(roleCounts, 5).map(([role, count]) => ({ role, count })),
    top_cities: sortMap(cityCounts, 5).map(([city, count]) => ({ city, count })),
    remote_first_companies: [...remoteCompanies].slice(0, 5),
    new_jobs_last_hour: newLastHour,
    total_jobs_analyzed: jobs.length,
    generated_at: new Date().toISOString(),
    ai_powered: false,
  };
}

export async function GET(_req: NextRequest) {
  try {
    // Serve from cache if fresh
    if (insightsCache && Date.now() < insightsCache.expiresAt) {
      return NextResponse.json(insightsCache.data);
    }

    // Load jobs
    let jobs: any[] = [];
    try {
      jobs = isPgAvailable ? await dbLoadJobs() : loadJobState().jobs;
    } catch {
      jobs = loadJobState().jobs;
    }

    if (jobs.length === 0) {
      const empty: AiInsights = {
        top_hiring_companies: [],
        trending_skills: [],
        fastest_growing_roles: [],
        top_cities: [],
        remote_first_companies: [],
        new_jobs_last_hour: 0,
        total_jobs_analyzed: 0,
        generated_at: new Date().toISOString(),
        ai_powered: false,
      };
      return NextResponse.json(empty);
    }

    // Try AI-powered insights for a rich summary
    let insights: AiInsights = computeHeuristicInsights(jobs);

    if (isAiEnabled() && jobs.length > 10) {
      // Build a compact job summary (first 80 jobs, key fields only)
      const sample = jobs.slice(0, 80).map(j => ({
        title: j.job_title,
        company: j.company_name,
        city: j.city || j.location?.split(',')[0],
        skills: (j.skills || []).slice(0, 5),
        mode: j.work_mode,
        ts: j.first_seen_timestamp,
      }));

      const model = getModel('classify'); // fast model for aggregation
      const resp = await callOpenRouter({
        systemPrompt: INSIGHTS_SYSTEM_PROMPT,
        userContent: buildInsightsPrompt(JSON.stringify(sample)),
        model: model.modelId,
        maxTokens: 800,
        temperature: 0.0,
      });

      if (resp.success) {
        const parsed = parseAiJson<Omit<AiInsights, 'generated_at' | 'ai_powered' | 'total_jobs_analyzed'>>(resp.content);
        if (parsed) {
          insights = {
            ...computeHeuristicInsights(jobs), // keep new_jobs_last_hour as heuristic
            ...parsed,
            total_jobs_analyzed: jobs.length,
            generated_at: new Date().toISOString(),
            ai_powered: true,
          };
        }
      }
    }

    // Cache the result
    insightsCache = { data: insights, expiresAt: Date.now() + CACHE_TTL_MS };

    return NextResponse.json(insights);
  } catch (err: any) {
    console.error('[AI Insights] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
