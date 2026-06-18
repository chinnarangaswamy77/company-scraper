import { NextRequest, NextResponse } from 'next/server';
import { isAiEnabled } from '@/lib/ai/model-registry';
import { callOpenRouter, parseAiJson } from '@/lib/ai/openrouter-client';
import { NL_SEARCH_SYSTEM_PROMPT, buildNlSearchPrompt } from '@/lib/ai/prompts';
import { getModel } from '@/lib/ai/model-registry';
import { loadCandidateProfile } from '@/lib/ai/candidate-profile';
import { heuristicMatchScore, computeFreshnessScore } from '@/lib/ai/ranker';
import { dbLoadJobs, isPgAvailable } from '@/lib/db';
import { loadJobState } from '@/lib/job-scraper';

interface NlFilters {
  job_title_keywords?: string[];
  skills?: string[];
  location?: string | null;
  work_mode?: 'remote' | 'onsite' | 'hybrid' | null;
  experience_max_years?: number | null;
  experience_min_years?: number | null;
  employment_type?: string | null;
  source_filter?: string | null;
}

function applyFilters(jobs: any[], filters: NlFilters, profile: any): any[] {
  return jobs
    .filter(job => {
      const titleLower = (job.job_title || '').toLowerCase();
      const descLower = (job.description || '').toLowerCase();
      const locLower = (job.location || '').toLowerCase();
      const mode = (job.work_mode || '').toLowerCase();

      // Title keywords
      if (filters.job_title_keywords?.length) {
        const matched = filters.job_title_keywords.some(kw =>
          titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
        );
        if (!matched) return false;
      }

      // Skills
      if (filters.skills?.length) {
        const jobSkills = (job.skills || []).map((s: string) => s.toLowerCase());
        const anyMatch = filters.skills.some(sk => jobSkills.includes(sk.toLowerCase()));
        if (!anyMatch) return false;
      }

      // Location
      if (filters.location) {
        const loc = filters.location.toLowerCase();
        if (loc === 'remote') {
          if (mode !== 'remote' && !locLower.includes('remote')) return false;
        } else {
          if (!locLower.includes(loc)) return false;
        }
      }

      // Work mode
      if (filters.work_mode && filters.work_mode !== mode) {
        if (!(filters.work_mode === 'remote' && locLower.includes('remote'))) return false;
      }

      // Employment type
      if (filters.employment_type) {
        const empType = (job.employment_type || '').toLowerCase();
        if (!empType.includes(filters.employment_type.toLowerCase())) return false;
      }

      // Experience
      if (filters.experience_max_years !== null && filters.experience_max_years !== undefined) {
        const expMatch = (job.experience_required || '').match(/(\d+)/);
        if (expMatch) {
          const minExp = parseInt(expMatch[1]);
          if (minExp > filters.experience_max_years) return false;
        }
      }

      // Source
      if (filters.source_filter) {
        const src = (job.source_name || '').toLowerCase();
        if (!src.includes(filters.source_filter.toLowerCase())) return false;
      }

      return true;
    })
    .map(job => {
      const h = heuristicMatchScore(job, profile);
      const freshness = computeFreshnessScore(job.posted_date || null);
      return {
        ...job,
        match_score: job.match_score ?? h.score,
        freshness_score: job.freshness_score ?? freshness,
        composite_score: job.composite_score ?? Math.round(h.score * 0.6 + freshness * 0.4),
      };
    })
    .sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = body.query?.trim();

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const profile = loadCandidateProfile();

    // Load jobs
    let jobs: any[] = [];
    try {
      jobs = isPgAvailable ? await dbLoadJobs() : loadJobState().jobs;
    } catch {
      jobs = loadJobState().jobs;
    }

    // Try AI-powered NL query parsing
    let filters: NlFilters = {};

    if (isAiEnabled()) {
      const model = getModel('nl');
      const resp = await callOpenRouter({
        systemPrompt: NL_SEARCH_SYSTEM_PROMPT,
        userContent: buildNlSearchPrompt(query),
        model: model.modelId,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
      });

      if (resp.success) {
        const parsed = parseAiJson<NlFilters>(resp.content);
        if (parsed) filters = parsed;
      }
    }

    // Fallback: simple keyword extraction if AI is off or failed
    if (!filters.job_title_keywords?.length) {
      const roleWords = query.match(/\b(developer|engineer|designer|manager|analyst|intern|devops|frontend|backend|fullstack|data|product|qa)\b/gi);
      if (roleWords) filters.job_title_keywords = roleWords;
    }
    if (!filters.location && /remote|wfh/i.test(query)) filters.work_mode = 'remote';
    if (!filters.location) {
      const cityMatch = query.match(/\b(bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurugram|chennai)\b/i);
      if (cityMatch) filters.location = cityMatch[1];
    }

    const results = applyFilters(jobs, filters, profile);

    return NextResponse.json({
      count: results.length,
      filters,
      jobs: results.slice(0, 100),
      ai_powered: isAiEnabled(),
    });
  } catch (err: any) {
    console.error('[AI Search] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
