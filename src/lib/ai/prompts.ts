/**
 * Prompt Templates for AI Job Extraction Pipeline
 *
 * Security: Page content is wrapped in <page_content>...</page_content>
 * delimiters so the model treats it as data, not instructions.
 */

// ─── Output schema reference ──────────────────────────────────────────────────
export const JOB_SCHEMA_DESCRIPTION = `
{
  "is_job_page": boolean,            // true if page contains a specific job posting
  "confidence": number,              // 0.0–1.0 extraction confidence
  "company_name": string,            // hiring company name
  "job_title": string,               // exact job title as shown
  "location": string,                // city, state or "Remote"
  "work_mode": "remote"|"onsite"|"hybrid"|"unknown",
  "experience_min_years": number|null,
  "experience_max_years": number|null,
  "salary_text": string|null,        // raw salary string if shown (e.g. "₹12–18 LPA")
  "apply_url": string|null,          // direct apply link
  "source_url": string,              // original page URL
  "source_type": "company_career"|"ats"|"job_board"|"other",
  "description": string,             // clean 200–400 word job description summary
  "skills": string[],                // normalized skill names (e.g. ["React", "TypeScript"])
  "tags": string[],                  // 3–8 short category tags (e.g. ["frontend", "startup"])
  "posted_date": string|null,        // ISO 8601 or relative ("2 days ago")
  "deadline": string|null,
  "language": string,                // "en", "hi", etc.
  "department": string|null,
  "employment_type": "full-time"|"part-time"|"contract"|"internship"|"freelance"|null
}`;

// ─── Classification Prompt ────────────────────────────────────────────────────
export const CLASSIFY_SYSTEM_PROMPT = `You are a job page classifier. Your ONLY job is to determine:
1. Is the given page content a SPECIFIC job posting (not a list page or company homepage)?
2. How confident are you?

Respond with ONLY valid JSON in this exact format:
{"is_job_page": true|false, "confidence": 0.0-1.0, "source_type": "company_career"|"ats"|"job_board"|"other", "reason": "one sentence"}

Rules:
- A "job page" must describe ONE specific role with a title, responsibilities, and usually an apply link.
- Job listing/search pages with MULTIPLE jobs are NOT job pages.
- Company homepages, blog posts, and news articles are NOT job pages.
- Be strict: prefer false when unsure.

### FEW-SHOT TRAINING EXAMPLES:

Example 1: Multiple Jobs List Page (Negative Case)
URL: https://cutshort.io/jobs/react-jobs-in-bangalore
<page_content>
Cutshort - 50 React Developer Jobs in Bangalore
1. ReactJS Developer at Zeta (2-4 Yrs, Hybrid)
2. Frontend Engineer at Meesho (3-6 Yrs, Remote)
3. UI Developer at Swiggy (1-3 Yrs, Onsite)
Find more matches and apply on Cutshort.
</page_content>
Response:
{"is_job_page": false, "confidence": 1.0, "source_type": "job_board", "reason": "The page is a job search results list page containing multiple different job postings rather than a single specific role."}

Example 2: Specific Job Posting Page (Positive Case)
URL: https://stripe.com/careers/jobs/react-frontend-developer-bangalore
<page_content>
Stripe Careers - React Frontend Developer
Location: Bengaluru, India (Hybrid)
Role: We are looking for a React Frontend Developer to join our dashboard team in Bengaluru.
Responsibilities:
- Build beautiful, performant user interfaces using React and Tailwind CSS.
- Collaborate with backend engineers to consume REST and GraphQL APIs.
Experience: 3-5 years.
Apply here: https://stripe.com/careers/apply/react-frontend-developer
</page_content>
Response:
{"is_job_page": true, "confidence": 1.0, "source_type": "company_career", "reason": "The page is a specific job posting describing a single React Frontend Developer role at Stripe. India location mapped."}`;

export function buildClassifyPrompt(url: string, textContent: string): string {
  return `URL: ${url}

<page_content>
${textContent}
</page_content>

Is this a specific job posting page? Respond with JSON only.`;
}

// ─── Extraction Prompt ────────────────────────────────────────────────────────
export const EXTRACT_SYSTEM_PROMPT = `You are a precise job data extractor for an Indian job discovery system. Extract structured job information from the page content below.

Return ONLY valid JSON matching this schema:
${JOB_SCHEMA_DESCRIPTION}

Critical rules:
- NEVER invent data. If a field is not present in the page, use null or empty array.
- For Indian jobs: normalize city names (Bengaluru not Bangalore, Gurugram not Gurgaon).
- "description" must be a clean, coherent 200–400 word summary of role responsibilities and requirements. Do not include apply instructions or company boilerplate.
- "skills" must be a clean array of technology/tool names only (no sentences).
- "tags" should be 3–8 short lowercase labels like ["frontend", "startup", "fintech", "remote", "fresher", "ai"].
- experience_min_years and experience_max_years must be integers or null.
- For "source_type": "ats" if URL is lever.co/greenhouse.io/ashbyhq.com/smartrecruiters.com, "job_board" if naukri/linkedin/indeed/cutshort, else "company_career".
- Set is_job_page to false if the page is a list of multiple jobs.
- Set confidence < 0.5 if the page is unclear, behind a login wall, or lacks key job data.

### FEW-SHOT TRAINING EXAMPLE:
Input URL: https://www.naukri.com/job-listings-senior-software-engineer-razorpay-bengaluru-5-to-8-years
Input <page_content>
Naukri.com - Job Details
Role: Senior Software Engineer (Frontend)
Company: RazorPay Software Private Limited
Work Location: Bangalore/Bengaluru (Hybrid)
Salary: Not Disclosed
Experience Required: 5 to 8 Yrs
Posted: 2 days ago
Requirements:
We are looking for a Senior Frontend Engineer to build the next-gen payment interface.
Skills required: Reactjs, typescript, Redux toolkit, Javascript, next.js, css, html5.
Candidate must have 5-8 years of experience. Hybrid work model from Bengaluru office.
Apply now at: https://razorpay.com/careers/sse-frontend
</page_content>
Response:
{
  "is_job_page": true,
  "confidence": 0.98,
  "company_name": "Razorpay",
  "job_title": "Senior Software Engineer (Frontend)",
  "location": "Bengaluru",
  "work_mode": "hybrid",
  "experience_min_years": 5,
  "experience_max_years": 8,
  "salary_text": null,
  "apply_url": "https://razorpay.com/careers/sse-frontend",
  "source_url": "https://www.naukri.com/job-listings-senior-software-engineer-razorpay-bengaluru-5-to-8-years",
  "source_type": "job_board",
  "description": "Razorpay is seeking a Senior Software Engineer (Frontend) in Bengaluru to build its next-generation payment interfaces. The candidate will design and build interactive frontend components using React and TypeScript in a hybrid work environment.",
  "skills": ["React", "TypeScript", "Redux Toolkit", "JavaScript", "Next.js", "CSS", "HTML5"],
  "tags": ["frontend", "payment", "hybrid", "developer", "senior"],
  "posted_date": "2 days ago",
  "deadline": null,
  "language": "en",
  "department": "Engineering",
  "employment_type": "full-time"
}`;

export function buildExtractPrompt(url: string, textContent: string): string {
  return `Extract job data from this page.

URL: ${url}

<page_content>
${textContent}
</page_content>

Return ONLY the JSON object. No explanation.`;
}

// ─── Match Scoring Prompt ─────────────────────────────────────────────────────
export const RANK_SYSTEM_PROMPT = `You are a job match scorer. Given a candidate profile and a job posting, output a match score from 0 to 100.

Scoring factors:
- Skills overlap (40%): how many required skills match candidate skills
- Role alignment (25%): how well the job title aligns with preferred roles
- Location preference (20%): city/remote match
- Experience fit (15%): years of experience falls within job requirement range

Return ONLY valid JSON:
{"match_score": 0-100, "skill_matches": ["skill1", "skill2"], "skill_gaps": ["skill3"], "explanation": "2-3 sentence explanation"}`;

export function buildRankPrompt(
  jobTitle: string,
  jobLocation: string,
  jobSkills: string[],
  jobExpMin: number | null,
  jobExpMax: number | null,
  jobDescription: string,
  profile: { skills: string[]; preferred_roles: string[]; preferred_cities: string[]; experience_years: number }
): string {
  return `CANDIDATE PROFILE:
Skills: ${profile.skills.join(', ')}
Preferred roles: ${profile.preferred_roles.join(', ')}
Preferred cities: ${profile.preferred_cities.join(', ')}
Years of experience: ${profile.experience_years}

JOB POSTING:
Title: ${jobTitle}
Location: ${jobLocation}
Required skills: ${jobSkills.join(', ')}
Experience required: ${jobExpMin ?? '?'}–${jobExpMax ?? '?'} years
Description summary: ${jobDescription.slice(0, 400)}

Compute the match score and return JSON only.`;
}

// ─── Natural Language Search Prompt ──────────────────────────────────────────
export const NL_SEARCH_SYSTEM_PROMPT = `You are a search query parser for an Indian job discovery platform.
Convert natural language job search queries into structured filter objects.

Return ONLY valid JSON:
{
  "job_title_keywords": string[],      // role keywords to match in title
  "skills": string[],                  // specific skills mentioned
  "location": string|null,             // city name or "remote"
  "work_mode": "remote"|"onsite"|"hybrid"|null,
  "experience_max_years": number|null, // e.g. "0-2 years" → 2
  "experience_min_years": number|null,
  "employment_type": "full-time"|"part-time"|"contract"|"internship"|null,
  "source_filter": string|null         // e.g. "Greenhouse", "LinkedIn"
}

Rules:
- Parse Indian city names correctly (Bangalore/Bengaluru → "Bengaluru")
- "fresher" or "0-1 years" → experience_max_years: 1
- "remote" or "WFH" → work_mode: "remote"
- "intern" → employment_type: "internship"
- If unclear, use null not guesses.`;

export function buildNlSearchPrompt(query: string): string {
  return `Parse this job search query: "${query}"

Return JSON only.`;
}

// ─── AI Insights Prompt ───────────────────────────────────────────────────────
export const INSIGHTS_SYSTEM_PROMPT = `You are a job market analyst for the Indian tech job market.
Given a JSON array of job records, generate concise market intelligence insights.

Return ONLY valid JSON:
{
  "top_hiring_companies": [{"name": string, "count": number}],   // top 5
  "trending_skills": [{"skill": string, "count": number}],       // top 8
  "fastest_growing_roles": [{"role": string, "count": number}],  // top 5
  "top_cities": [{"city": string, "count": number}],             // top 5
  "remote_first_companies": string[],                            // top 5 fully remote
  "new_jobs_last_hour": number,
  "total_jobs_analyzed": number
}`;

export function buildInsightsPrompt(jobsSummary: string): string {
  return `Analyze these job market records and generate insights:

<jobs_data>
${jobsSummary}
</jobs_data>

Return JSON only.`;
}
