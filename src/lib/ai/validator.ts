/**
 * AI Job Schema Validator & Normalizer
 * Validates raw AI JSON output, normalizes fields, rejects hallucinations.
 */

export interface AiJobSchema {
  is_job_page: boolean;
  confidence: number;
  company_name: string;
  job_title: string;
  location: string;
  work_mode: 'remote' | 'onsite' | 'hybrid' | 'unknown';
  experience_min_years: number | null;
  experience_max_years: number | null;
  salary_text: string | null;
  apply_url: string | null;
  source_url: string;
  source_type: 'company_career' | 'ats' | 'job_board' | 'other';
  description: string;
  skills: string[];
  tags: string[];
  posted_date: string | null;
  deadline: string | null;
  language: string;
  department: string | null;
  employment_type: 'full-time' | 'part-time' | 'contract' | 'internship' | 'freelance' | null;
}

export interface ValidationResult {
  valid: boolean;
  job: AiJobSchema | null;
  errors: string[];
}

// ─── Location aliases ─────────────────────────────────────────────────────────
const CITY_ALIASES: Record<string, string> = {
  'bangalore': 'Bengaluru',
  'bengaluru': 'Bengaluru',
  'gurgaon': 'Gurugram',
  'gurugram': 'Gurugram',
  'bombay': 'Mumbai',
  'mumbai': 'Mumbai',
  'new delhi': 'Delhi',
  'delhi ncr': 'Delhi NCR',
  'ncr': 'Delhi NCR',
  'hyderabad': 'Hyderabad',
  'pune': 'Pune',
  'chennai': 'Chennai',
  'noida': 'Noida',
  'kolkata': 'Kolkata',
  'calcutta': 'Kolkata',
  'kochi': 'Kochi',
  'cochin': 'Kochi',
  'ahmedabad': 'Ahmedabad',
  'trivandrum': 'Thiruvananthapuram',
  'thiruvananthapuram': 'Thiruvananthapuram',
};

function normalizeLocation(loc: string): string {
  if (!loc) return 'India';
  const lower = loc.toLowerCase().trim();
  if (lower === 'remote' || lower === 'wfh' || lower === 'work from home') return 'Remote';
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  // Title-case unknown location
  return loc.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ─── Title cleanup ────────────────────────────────────────────────────────────
function normalizeTitle(title: string): string {
  if (!title) return 'Job Opening';
  return title
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s\-\+\.\#\/]/g, '')
    .trim()
    .split(' ')
    .map(w => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ');
}

// ─── Skills normalization ─────────────────────────────────────────────────────
const SKILL_ALIASES: Record<string, string> = {
  'reactjs': 'React',
  'react.js': 'React',
  'vuejs': 'Vue.js',
  'vue': 'Vue.js',
  'nodejs': 'Node.js',
  'node': 'Node.js',
  'expressjs': 'Express.js',
  'express': 'Express.js',
  'nextjs': 'Next.js',
  'next.js': 'Next.js',
  'typescript': 'TypeScript',
  'javascript': 'JavaScript',
  'python': 'Python',
  'golang': 'Go',
  'golang lang': 'Go',
  'postgresql': 'PostgreSQL',
  'postgres': 'PostgreSQL',
  'mongodb': 'MongoDB',
  'mongo': 'MongoDB',
  'aws': 'AWS',
  'amazon web services': 'AWS',
  'gcp': 'GCP',
  'google cloud': 'GCP',
  'azure': 'Azure',
  'kubernetes': 'Kubernetes',
  'k8s': 'Kubernetes',
  'docker': 'Docker',
  'graphql': 'GraphQL',
  'restapi': 'REST API',
  'rest api': 'REST API',
};

function normalizeSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(s => typeof s === 'string' && s.length > 0 && s.length < 60)
    .map(s => {
      const lower = (s as string).toLowerCase().trim();
      return SKILL_ALIASES[lower] || (s as string).trim();
    })
    .filter((v, i, arr) => arr.indexOf(v) === i) // deduplicate
    .slice(0, 20);
}

// ─── Known allowed fields ─────────────────────────────────────────────────────
const ALLOWED_FIELDS = new Set([
  'is_job_page', 'confidence', 'company_name', 'job_title', 'location',
  'work_mode', 'experience_min_years', 'experience_max_years', 'salary_text',
  'apply_url', 'source_url', 'source_type', 'description', 'skills', 'tags',
  'posted_date', 'deadline', 'language', 'department', 'employment_type',
  // Allow but strip these hallucinated extras
  'reason', 'notes', 'raw_title', 'raw_location'
]);

/**
 * Validates and normalizes raw AI JSON output into AiJobSchema.
 * Returns { valid: false } if critical fields are missing or incorrect.
 */
export function validateAiJobSchema(raw: unknown, sourceUrl: string): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, job: null, errors: ['Output is not a JSON object'] };
  }

  const obj = raw as Record<string, unknown>;

  // Strip unknown keys to prevent hallucinated field injection
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      delete obj[key];
    }
  }

  // is_job_page check
  if (obj.is_job_page === false || obj.is_job_page === 'false') {
    return { valid: false, job: null, errors: ['AI classified as non-job-page'] };
  }

  // confidence
  const confidence = typeof obj.confidence === 'number'
    ? Math.max(0, Math.min(1, obj.confidence))
    : 0.5;

  // Required fields
  const job_title = typeof obj.job_title === 'string' && obj.job_title.trim()
    ? normalizeTitle(obj.job_title as string)
    : '';
  const company_name = typeof obj.company_name === 'string' && obj.company_name.trim()
    ? (obj.company_name as string).trim()
    : '';

  if (!job_title) errors.push('Missing job_title');
  if (!company_name) errors.push('Missing company_name');
  if (errors.length > 0) return { valid: false, job: null, errors };

  // Work mode normalization
  const rawMode = String(obj.work_mode || '').toLowerCase();
  const work_mode: AiJobSchema['work_mode'] =
    rawMode === 'remote' ? 'remote' :
    rawMode === 'hybrid' ? 'hybrid' :
    rawMode === 'onsite' || rawMode === 'on-site' || rawMode === 'in-office' ? 'onsite' :
    'unknown';

  // Source type normalization
  const rawSourceType = String(obj.source_type || '').toLowerCase();
  const source_type: AiJobSchema['source_type'] =
    rawSourceType === 'ats' ? 'ats' :
    rawSourceType === 'job_board' ? 'job_board' :
    rawSourceType === 'company_career' ? 'company_career' :
    'other';

  // Employment type
  const rawEmpType = String(obj.employment_type || '').toLowerCase();
  const employment_type: AiJobSchema['employment_type'] =
    rawEmpType.includes('full') ? 'full-time' :
    rawEmpType.includes('part') ? 'part-time' :
    rawEmpType.includes('contract') || rawEmpType.includes('freelance') ? 'contract' :
    rawEmpType.includes('intern') ? 'internship' :
    null;

  // Experience
  const experience_min_years = typeof obj.experience_min_years === 'number'
    ? Math.max(0, Math.floor(obj.experience_min_years)) : null;
  const experience_max_years = typeof obj.experience_max_years === 'number'
    ? Math.min(50, Math.ceil(obj.experience_max_years)) : null;

  // Apply URL validation
  let apply_url: string | null = null;
  if (typeof obj.apply_url === 'string' && obj.apply_url.startsWith('http')) {
    try { new URL(obj.apply_url); apply_url = obj.apply_url; } catch { }
  }

  // Tags
  const tags: string[] = Array.isArray(obj.tags)
    ? (obj.tags as unknown[]).filter(t => typeof t === 'string').map(t => (t as string).toLowerCase().trim()).slice(0, 8)
    : [];

  const job: AiJobSchema = {
    is_job_page: true,
    confidence,
    company_name,
    job_title,
    location: normalizeLocation(String(obj.location || 'India')),
    work_mode,
    experience_min_years,
    experience_max_years,
    salary_text: typeof obj.salary_text === 'string' ? obj.salary_text.trim() || null : null,
    apply_url: apply_url || (sourceUrl.startsWith('http') ? sourceUrl : null),
    source_url: sourceUrl,
    source_type,
    description: typeof obj.description === 'string'
      ? obj.description.slice(0, 1000).trim()
      : '',
    skills: normalizeSkills(obj.skills),
    tags,
    posted_date: typeof obj.posted_date === 'string' ? obj.posted_date.trim() || null : null,
    deadline: typeof obj.deadline === 'string' ? obj.deadline.trim() || null : null,
    language: typeof obj.language === 'string' ? obj.language.slice(0, 5) : 'en',
    department: typeof obj.department === 'string' ? obj.department.trim() || null : null,
    employment_type,
  };

  return { valid: true, job, errors: [] };
}

/**
 * Converts a validated AiJobSchema into a partial ScrapedJob.
 * Used to merge AI results into the existing DB record format.
 */
export function aiJobToScrapedJobFields(job: AiJobSchema): Record<string, unknown> {
  const expText = job.experience_min_years !== null && job.experience_max_years !== null
    ? `${job.experience_min_years}-${job.experience_max_years} years`
    : job.experience_min_years !== null
      ? `${job.experience_min_years}+ years`
      : '';

  return {
    job_title: job.job_title,
    company_name: job.company_name,
    location: job.location,
    work_mode: job.work_mode,
    experience_required: expText,
    skills: job.skills,
    department: job.department || '',
    description: job.description,
    apply_url: job.apply_url || '',
    salary_range: job.salary_text || '',
    posted_date: job.posted_date || new Date().toISOString(),
    application_deadline: job.deadline || '',
    source_type: job.source_type === 'ats' || job.source_type === 'company_career' ? 'OFFICIAL' : 'THIRD_PARTY',
    // AI-specific fields
    ai_confidence: job.confidence,
    ai_extracted: true,
    tags: job.tags,
    language: job.language,
    employment_type: job.employment_type || 'full-time',
  };
}

export type ConfidenceTier = 'high' | 'medium' | 'low' | 'rejected';

export interface AiExtractResult {
  success: boolean;
  isJobPage: boolean;
  confidence: number;
  tier: ConfidenceTier;
  reviewNeeded: boolean;
  job: AiJobSchema | null;
  /** Merged fields ready to apply to a ScrapedJob record */
  scrapedJobFields: Record<string, unknown> | null;
  matchScore: number;
  freshnessScore: number;
  compositeScore: number;
  skillMatches: string[];
  skillGaps: string[];
  matchExplanation: string;
  aiRanked: boolean;
  modelUsed: string;
  latencyMs: number;
  error?: string;
}

