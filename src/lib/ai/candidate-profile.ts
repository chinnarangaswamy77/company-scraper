/**
 * Candidate Profile Loader
 * Loads from scratch/candidate_profile.json if it exists, else uses defaults.
 * Used by the AI ranker for match scoring.
 */

import fs from 'fs';
import path from 'path';

export interface CandidateProfile {
  skills: string[];
  preferred_roles: string[];
  preferred_cities: string[];
  experience_years: number;
  employment_type: 'full-time' | 'part-time' | 'contract' | 'internship' | 'any';
  remote_ok: boolean;
  salary_min_lpa: number | null;
  salary_max_lpa: number | null;
}

const DEFAULT_PROFILE: CandidateProfile = {
  skills: ['React', 'TypeScript', 'Node.js', 'JavaScript', 'Python', 'SQL'],
  preferred_roles: ['Frontend Developer', 'Full Stack Developer', 'Software Engineer'],
  preferred_cities: ['Bengaluru', 'Hyderabad', 'Pune', 'Remote'],
  experience_years: 2,
  employment_type: 'full-time',
  remote_ok: true,
  salary_min_lpa: null,
  salary_max_lpa: null,
};

let cachedProfile: CandidateProfile | null = null;

export function loadCandidateProfile(): CandidateProfile {
  if (cachedProfile) return cachedProfile;

  // Try loading from the scratch directory
  const profilePath = path.join(process.cwd(), 'scratch', 'candidate_profile.json');
  try {
    if (fs.existsSync(profilePath)) {
      const raw = fs.readFileSync(profilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CandidateProfile>;
      cachedProfile = { ...DEFAULT_PROFILE, ...parsed };
      console.log('[CandidateProfile] Loaded from candidate_profile.json');
      return cachedProfile;
    }
  } catch (err: any) {
    console.warn('[CandidateProfile] Failed to load profile file, using defaults:', err.message);
  }

  cachedProfile = DEFAULT_PROFILE;
  return cachedProfile;
}

/** Force-reload profile (clears cache) */
export function reloadCandidateProfile(): CandidateProfile {
  cachedProfile = null;
  return loadCandidateProfile();
}

/** Save a new profile to disk */
export function saveCandidateProfile(profile: CandidateProfile): void {
  const profilePath = path.join(process.cwd(), 'scratch', 'candidate_profile.json');
  try {
    const dir = path.dirname(profilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
    cachedProfile = profile;
    console.log('[CandidateProfile] Saved to candidate_profile.json');
  } catch (err: any) {
    console.error('[CandidateProfile] Failed to save profile:', err.message);
  }
}
