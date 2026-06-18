import fs from 'fs';
import path from 'path';
import pg from 'pg';

export interface ScrapedJob {
  job_id: string;
  company_name: string;
  company_website: string;
  career_page_url: string;
  job_title: string;
  job_url: string;
  location: string;
  city: string;
  state: string;
  country: string;
  work_mode: string;
  employment_type: string;
  experience_required: string;
  skills: string[];
  department: string;
  posted_date: string;
  application_deadline: string;
  status: 'OPEN' | 'CLOSED';
  source_type: 'OFFICIAL' | 'THIRD_PARTY';
  source_name: string;
  first_seen_timestamp: string;
  last_seen_timestamp: string;
  description: string;
  apply_url: string;

  // AI enrichment fields (optional — populated after AI extraction)
  ai_confidence?: number;      // 0.00–1.00 extraction confidence
  ai_model_used?: string;      // e.g. "openai/gpt-oss-120b:free"
  ai_extracted?: boolean;      // true if AI pipeline processed this job
  review_needed?: boolean;     // true if confidence < 0.75
  match_score?: number;        // 0–100 candidate match score
  freshness_score?: number;    // 0–100 freshness score
  composite_score?: number;    // weighted composite of match + freshness
  tags?: string[];             // AI-generated category tags
  salary_range?: string;       // raw salary string
  language?: string;           // 'en', 'hi', etc.
  skill_matches?: string[];    // skills that matched candidate profile
  skill_gaps?: string[];       // missing skills from candidate profile
  match_explanation?: string;  // AI explanation of match score

  // Compatibility fields for the page.tsx UI
  id?: string;
  title?: string;
  companyName?: string;
  url?: string;
  scrapedAt?: string;
  postedDate?: string;
  remote?: boolean;
  salary?: string;
  job_fingerprint?: string;
  is_duplicate?: boolean;
  isDuplicate?: boolean;
  is_seeded?: boolean;
  isSeeded?: boolean;
}

export interface HourlyReport {
  scan_time: string;
  new_jobs_found: number;
  updated_jobs_found: number;
  closed_jobs_found: number;
  duplicate_jobs_skipped: number;
  companies_scanned: number;
}

export function getScratchDir(): string {
  const localDir = '/Users/ravipatichinnaranga/.gemini/antigravity-ide/scratch';
  try {
    if (fs.existsSync(localDir)) {
      fs.accessSync(localDir, fs.constants.W_OK);
      return localDir;
    }
  } catch (e) {}

  const fallbackDir = path.join(process.cwd(), 'scratch');
  if (!fs.existsSync(fallbackDir)) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
    } catch (e) {}
  }
  return fallbackDir;
}

const SCRATCH_DIR = getScratchDir();
const JOBS_JSON_FILE = path.join(SCRATCH_DIR, 'jobs_data.json');
const JOBS_CSV_FILE = path.join(SCRATCH_DIR, 'jobs_data.csv');
const LOGS_JSON_FILE = path.join(SCRATCH_DIR, 'hourly_reports_log.json');
const RAW_LOG_FILE = path.join(SCRATCH_DIR, 'raw_scrape_log.json');

export let pool: pg.Pool | null = null;
export let isPgAvailable = false;

if (process.env.PG_CONN_STRING) {
  const isRailwayInternal = process.env.PG_CONN_STRING.includes('railway.internal');
  const isOnRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_CONTAINER_URL);

  if (isRailwayInternal && !isOnRailway) {
    console.log('🔌 Local machine detected with Railway internal DB URL. Gracefully falling back to local file storage.');
    isPgAvailable = false;
  } else {
    try {
      pool = new pg.Pool({
        connectionString: process.env.PG_CONN_STRING,
        ssl: process.env.PG_CONN_STRING.includes('localhost') ? false : { rejectUnauthorized: false }
      });
      isPgAvailable = true;
      console.log('🔌 PostgreSQL Client detected and initialized.');
    } catch (err: any) {
      console.warn('⚠️ Postgres connection string provided, but "pg" library could not be loaded. Falling back to files:', err.message);
    }
  }
}

/**
 * Ensures tables are set up in PostgreSQL if available
 */
export async function initDatabase() {
  if (!isPgAvailable || !pool) return;
  try {
    const client = await pool.connect();
    try {
      // Create vector extension
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`).catch(() => {});

      // 1. Create companies table
      await client.query(`
        CREATE TABLE IF NOT EXISTS companies (
          company_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_name VARCHAR(255) UNIQUE NOT NULL,
          website VARCHAR(255),
          careers_url VARCHAR(255) NOT NULL,
          industry VARCHAR(100),
          country VARCHAR(100) DEFAULT 'India',
          city VARCHAR(100),
          employee_count INTEGER,
          tier VARCHAR(10) CHECK (tier IN ('Tier 1', 'Tier 2', 'Tier 3')) DEFAULT 'Tier 3',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Create jobs_discovery table
      await client.query(`
        CREATE TABLE IF NOT EXISTS jobs_discovery (
          job_id VARCHAR(100) PRIMARY KEY,
          company_name VARCHAR(255) NOT NULL,
          company_website VARCHAR(255),
          career_page_url TEXT,
          job_title VARCHAR(255) NOT NULL,
          job_url TEXT NOT NULL,
          location VARCHAR(255),
          city VARCHAR(255),
          state VARCHAR(255),
          country VARCHAR(100) DEFAULT 'India',
          work_mode VARCHAR(100),
          employment_type VARCHAR(100),
          experience_required VARCHAR(100),
          skills TEXT[],
          department VARCHAR(100),
          posted_date VARCHAR(100),
          application_deadline VARCHAR(100),
          status VARCHAR(50) DEFAULT 'OPEN',
          source_type VARCHAR(100) DEFAULT 'OFFICIAL',
          source_name VARCHAR(100),
          first_seen_timestamp VARCHAR(100),
          last_seen_timestamp VARCHAR(100),
          description TEXT,
          apply_url TEXT
        );
      `);

      // ── AI enrichment and company relation columns (safe migration) ───
      const aiColumns: [string, string][] = [
        ['ai_confidence',   'NUMERIC(4,2)'],
        ['ai_model_used',   'VARCHAR(150)'],
        ['ai_extracted',    'BOOLEAN DEFAULT FALSE'],
        ['review_needed',   'BOOLEAN DEFAULT FALSE'],
        ['match_score',     'INTEGER'],
        ['freshness_score', 'INTEGER'],
        ['composite_score', 'INTEGER'],
        ['tags',            'TEXT[]'],
        ['salary_range',    'VARCHAR(255)'],
        ['language',        'VARCHAR(10) DEFAULT \'en\''],
        ['deadline',        'VARCHAR(100)'],
        ['skill_matches',   'TEXT[]'],
        ['skill_gaps',      'TEXT[]'],
        ['match_explanation', 'TEXT'],
        ['company_id',      'UUID REFERENCES companies(company_id) ON DELETE SET NULL']
      ];
      for (const [col, def] of aiColumns) {
        await client.query(
          `ALTER TABLE jobs_discovery ADD COLUMN IF NOT EXISTS ${col} ${def}`
        ).catch(() => {}); // silently skip if column already exists
      }

      // 3. Create company sources
      await client.query(`
        CREATE TABLE IF NOT EXISTS company_sources (
          source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
          source_type VARCHAR(50) CHECK (source_type IN ('company_career', 'ats', 'job_board', 'other')),
          source_url VARCHAR(500) NOT NULL,
          last_crawled_at TIMESTAMP WITH TIME ZONE,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 4. Create ATS profiles
      await client.query(`
        CREATE TABLE IF NOT EXISTS ats_profiles (
          ats_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
          ats_type VARCHAR(50) CHECK (ats_type IN ('Greenhouse', 'Lever', 'Workday', 'Ashby', 'SmartRecruiters', 'Recruitee', 'BambooHR', 'Darwinbox', 'ZohoRecruit', 'SAPSuccessFactors', 'OracleTaleo', 'iCIMS', 'Comeet', 'Jobvite', 'Unknown')),
          fingerprint_hash VARCHAR(64) UNIQUE,
          custom_selector_rules JSONB,
          detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 5. Create job versions
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_versions (
          version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_id VARCHAR(100) REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
          payload JSONB NOT NULL,
          changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 6. Create job skills
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_skills (
          job_id VARCHAR(100) REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
          skill_name VARCHAR(100) NOT NULL,
          PRIMARY KEY (job_id, skill_name)
        );
      `);

      // 7. Create job scores
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_scores (
          job_id VARCHAR(100) PRIMARY KEY REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
          freshness_score DOUBLE PRECISION NOT NULL,
          trust_score DOUBLE PRECISION NOT NULL,
          company_quality_score DOUBLE PRECISION NOT NULL,
          candidate_match_score DOUBLE PRECISION NOT NULL,
          composite_score DOUBLE PRECISION NOT NULL,
          explanation TEXT
        );
      `);

      // 8. Create job embeddings
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_embeddings (
          job_id VARCHAR(100) PRIMARY KEY REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
          embedding vector(1536) NOT NULL
        );
      `);

      // 9. Create crawl queue
      await client.query(`
        CREATE TABLE IF NOT EXISTS crawl_queue (
          queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          url VARCHAR(500) UNIQUE NOT NULL,
          priority INTEGER DEFAULT 1,
          status VARCHAR(20) CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')) DEFAULT 'PENDING',
          retry_count INTEGER DEFAULT 0,
          next_retry_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 10. Create crawl logs
      await client.query(`
        CREATE TABLE IF NOT EXISTS crawl_logs (
          log_id SERIAL PRIMARY KEY,
          url VARCHAR(500) NOT NULL,
          worker_id VARCHAR(100),
          jobs_discovered INTEGER DEFAULT 0,
          status VARCHAR(50),
          error_message TEXT,
          duration_ms INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 11. Create AI logs
      await client.query(`
        CREATE TABLE IF NOT EXISTS ai_logs (
          log_id SERIAL PRIMARY KEY,
          job_id VARCHAR(100),
          model_id VARCHAR(100),
          tokens_input INTEGER DEFAULT 0,
          tokens_output INTEGER DEFAULT 0,
          cost_usd NUMERIC(10, 6) DEFAULT 0.0,
          latency_ms INTEGER,
          confidence DOUBLE PRECISION,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 12. Create analytics snapshots
      await client.query(`
        CREATE TABLE IF NOT EXISTS analytics_snapshots (
          snapshot_id SERIAL PRIMARY KEY,
          metrics JSONB NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 13. Create hourly reports
      await client.query(`
        CREATE TABLE IF NOT EXISTS hourly_reports (
          scan_time VARCHAR(100) PRIMARY KEY,
          new_jobs_found INTEGER DEFAULT 0,
          updated_jobs_found INTEGER DEFAULT 0,
          closed_jobs_found INTEGER DEFAULT 0,
          duplicate_jobs_skipped INTEGER DEFAULT 0,
          companies_scanned INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create scale indexes
      await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status_last_seen ON jobs_discovery(status, last_seen_timestamp DESC);`).catch(() => {});
      await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_embedding ON job_embeddings USING hnsw (embedding vector_cosine_ops);`).catch(() => {});
      await client.query(`CREATE INDEX IF NOT EXISTS idx_crawl_queue_priority_status ON crawl_queue(priority, status);`).catch(() => {});
      await client.query(`CREATE INDEX IF NOT EXISTS idx_company_name ON companies(company_name);`).catch(() => {});

      // Run database deduplication query to clean up any duplicates created by the old unstable fingerprint hashing bug
      const deleteRes = await client.query(`
        DELETE FROM jobs_discovery a USING jobs_discovery b
        WHERE a.job_id <> b.job_id
          AND (a.last_seen_timestamp < b.last_seen_timestamp OR (a.last_seen_timestamp = b.last_seen_timestamp AND a.job_id < b.job_id))
          AND (
            (
              -- Normalized company name match (strips Pvt, Ltd, Software, etc.)
              LOWER(REGEXP_REPLACE(REGEXP_REPLACE(a.company_name, $$\\b(pvt\\.?\\s*ltd\\.?|private\\s+limited|ltd\\.?|limited|inc\\.?|corporation|corp\\.?|co\\.?|company|india|development\\s+centre|r\\&d\\s+institute|r\\&d\\s+center|software\\s+centre|global\\s+software|technologies|solutions|software|it\\s+services|systems)\\b$$, '', 'gi'), $$[^a-z0-9]$$, '', 'g'))
              =
              LOWER(REGEXP_REPLACE(REGEXP_REPLACE(b.company_name, $$\\b(pvt\\.?\\s*ltd\\.?|private\\s+limited|ltd\\.?|limited|inc\\.?|corporation|corp\\.?|co\\.?|company|india|development\\s+centre|r\\&d\\s+institute|r\\&d\\s+center|software\\s+centre|global\\s+software|technologies|solutions|software|it\\s+services|systems)\\b$$, '', 'gi'), $$[^a-z0-9]$$, '', 'g'))
              
              -- Normalized title match (strips parentheticals like (React), [Immediate] and non-alphanumeric)
              AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(a.job_title, $$\\s*[\\(\\[][^\\]\\)]*[\\)\\]]$$, '', 'g'), $$[^a-z0-9]$$, '', 'g'))
              =
              LOWER(REGEXP_REPLACE(REGEXP_REPLACE(b.job_title, $$\\s*[\\(\\[][^\\]\\)]*[\\)\\]]$$, '', 'g'), $$[^a-z0-9]$$, '', 'g'))
              
              -- Normalized location/city match
              AND COALESCE(NULLIF(LOWER(REGEXP_REPLACE(a.city, $$[^a-z]$$, '', 'g')), ''), NULLIF(LOWER(REGEXP_REPLACE(a.location, $$[^a-z]$$, '', 'g')), ''), 'india')
              =
              COALESCE(NULLIF(LOWER(REGEXP_REPLACE(b.city, $$[^a-z]$$, '', 'g')), ''), NULLIF(LOWER(REGEXP_REPLACE(b.location, $$[^a-z]$$, '', 'g')), ''), 'india')
            )
            -- OR if URLs match (ignoring query parameters)
            OR SPLIT_PART(LOWER(a.job_url), '?', 1) = SPLIT_PART(LOWER(b.job_url), '?', 1)
            OR (a.apply_url IS NOT NULL AND b.apply_url IS NOT NULL AND SPLIT_PART(LOWER(a.apply_url), '?', 1) = SPLIT_PART(LOWER(b.apply_url), '?', 1))
          );
      `);
      if (deleteRes.rowCount && deleteRes.rowCount > 0) {
        console.log(`🧹 Database cleanup complete: removed ${deleteRes.rowCount} historical duplicate jobs from PostgreSQL.`);
      }

      console.log('✅ PostgreSQL Job Discovery tables verified/created successfully.');
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('❌ Failed to initialize PostgreSQL tables:', err.message);
  }
}

/**
 * Upserts a job record into PostgreSQL if configured
 */
export async function dbUpsertJob(job: ScrapedJob) {
  if (!isPgAvailable || !pool) return;
  try {
    const query = `
      INSERT INTO jobs_discovery (
        job_id, company_name, company_website, career_page_url, job_title,
        job_url, location, city, state, country, work_mode, employment_type,
        experience_required, skills, department, posted_date, application_deadline,
        status, source_type, source_name, first_seen_timestamp, last_seen_timestamp,
        description, apply_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (job_id) DO UPDATE SET
        job_title = EXCLUDED.job_title,
        location = EXCLUDED.location,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        employment_type = EXCLUDED.employment_type,
        work_mode = EXCLUDED.work_mode,
        experience_required = EXCLUDED.experience_required,
        skills = EXCLUDED.skills,
        status = EXCLUDED.status,
        last_seen_timestamp = EXCLUDED.last_seen_timestamp,
        description = EXCLUDED.description;
    `;
    await pool.query(query, [
      job.job_id,
      job.company_name,
      job.company_website,
      job.career_page_url,
      job.job_title,
      job.job_url,
      job.location,
      job.city,
      job.state,
      job.country,
      job.work_mode,
      job.employment_type,
      job.experience_required,
      job.skills,
      job.department,
      job.posted_date,
      job.application_deadline,
      job.status,
      job.source_type,
      job.source_name,
      job.first_seen_timestamp,
      job.last_seen_timestamp,
      job.description,
      job.apply_url
    ]);
  } catch (err: any) {
    console.error(`❌ Failed to upsert job "${job.job_title}" in DB:`, err.message);
  }
}

/**
 * Upserts a job with AI enrichment fields into PostgreSQL.
 * Extends the base upsert with all optional AI columns.
 */
export async function dbUpsertAiJob(job: ScrapedJob) {
  if (!isPgAvailable || !pool) return;
  try {
    // First do base upsert
    await dbUpsertJob(job);
    // Then patch the AI-specific fields
    const aiFields: Record<string, unknown> = {
      ai_confidence:    job.ai_confidence ?? null,
      ai_model_used:    job.ai_model_used ?? null,
      ai_extracted:     job.ai_extracted ?? false,
      review_needed:    job.review_needed ?? false,
      match_score:      job.match_score ?? null,
      freshness_score:  job.freshness_score ?? null,
      composite_score:  job.composite_score ?? null,
      tags:             job.tags ?? null,
      salary_range:     job.salary_range ?? null,
      language:         job.language ?? 'en',
      skill_matches:    job.skill_matches ?? null,
      skill_gaps:       job.skill_gaps ?? null,
      match_explanation: job.match_explanation ?? null,
    };
    const cols = Object.keys(aiFields);
    const vals = Object.values(aiFields);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE jobs_discovery SET ${sets} WHERE job_id = $1`,
      [job.job_id, ...vals]
    );
  } catch (err: any) {
    console.error(`❌ Failed to AI-upsert job "${job.job_title}":`, err.message);
  }
}

/**
 * Saves an Hourly Report into PostgreSQL
 */
export async function dbSaveHourlyReport(report: HourlyReport) {
  if (!isPgAvailable || !pool) return;
  try {
    const query = `
      INSERT INTO hourly_reports (
        scan_time, new_jobs_found, updated_jobs_found, closed_jobs_found, duplicate_jobs_skipped,
        companies_scanned
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (scan_time) DO UPDATE SET
        new_jobs_found = EXCLUDED.new_jobs_found,
        updated_jobs_found = EXCLUDED.updated_jobs_found,
        closed_jobs_found = EXCLUDED.closed_jobs_found,
        duplicate_jobs_skipped = EXCLUDED.duplicate_jobs_skipped,
        companies_scanned = EXCLUDED.companies_scanned;
    `;
    await pool.query(query, [
      report.scan_time,
      report.new_jobs_found,
      report.updated_jobs_found,
      report.closed_jobs_found,
      report.duplicate_jobs_skipped,
      report.companies_scanned
    ]);
  } catch (err: any) {
    console.error(`❌ Failed to save hourly report for ${report.scan_time} in DB:`, err.message);
  }
}

/**
 * Escape field content for CSV format
 */
function escapeCSV(val: any): string {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    val = val.join('; ');
  }
  let str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    str = str.replace(/"/g, '""');
    return `"${str}"`;
  }
  return str;
}

/**
 * Writes the active list of scraped jobs to a CSV spreadsheet file (Layer 3)
 */
export function exportToCSV(jobs: ScrapedJob[]) {
  try {
    const headers = [
      'job_id', 'company_name', 'company_website', 'career_page_url', 'job_title',
      'job_url', 'location', 'city', 'state', 'country', 'work_mode', 'employment_type',
      'experience_required', 'skills', 'department', 'posted_date', 'application_deadline',
      'status', 'source_type', 'source_name', 'first_seen_timestamp', 'last_seen_timestamp',
      'description', 'apply_url'
    ];

    const csvLines = [headers.join(',')];

    for (const job of jobs) {
      const line = [
        escapeCSV(job.job_id),
        escapeCSV(job.company_name),
        escapeCSV(job.company_website),
        escapeCSV(job.career_page_url),
        escapeCSV(job.job_title),
        escapeCSV(job.job_url),
        escapeCSV(job.location),
        escapeCSV(job.city),
        escapeCSV(job.state),
        escapeCSV(job.country),
        escapeCSV(job.work_mode),
        escapeCSV(job.employment_type),
        escapeCSV(job.experience_required),
        escapeCSV(job.skills),
        escapeCSV(job.department),
        escapeCSV(job.posted_date),
        escapeCSV(job.application_deadline),
        escapeCSV(job.status),
        escapeCSV(job.source_type),
        escapeCSV(job.source_name),
        escapeCSV(job.first_seen_timestamp),
        escapeCSV(job.last_seen_timestamp),
        escapeCSV(job.description),
        escapeCSV(job.apply_url)
      ];
      csvLines.push(line.join(','));
    }

    fs.writeFileSync(JOBS_CSV_FILE, csvLines.join('\n'), 'utf-8');
  } catch (err: any) {
    console.error('❌ Failed to write jobs CSV file:', err.message);
  }
}

/**
 * Saves raw scrape sweep logs (Layer 1)
 */
export function saveRawScrapeLog(jobs: ScrapedJob[]) {
  try {
    let currentLogs: any[] = [];
    if (fs.existsSync(RAW_LOG_FILE)) {
      const content = fs.readFileSync(RAW_LOG_FILE, 'utf-8');
      try {
        currentLogs = JSON.parse(content);
      } catch (e) {}
    }
    const rawEntry = {
      scan_time: new Date().toISOString(),
      raw_jobs_scraped: jobs.map(j => ({
        job_id: j.job_id,
        job_title: j.job_title,
        company_name: j.company_name,
        job_url: j.job_url,
        source_name: j.source_name,
        raw_text_length: j.description?.length || 0
      }))
    };
    currentLogs.unshift(rawEntry);
    if (currentLogs.length > 100) {
      currentLogs = currentLogs.slice(0, 100);
    }
    fs.writeFileSync(RAW_LOG_FILE, JSON.stringify(currentLogs, null, 2), 'utf-8');
  } catch (err: any) {
    console.error('❌ Failed to write raw scrape logs:', err.message);
  }
}

/**
 * Append or save an hourly report object to a local reports log history
 */
export function saveLocalHourlyReport(report: HourlyReport) {
  try {
    let reports: HourlyReport[] = [];
    if (fs.existsSync(LOGS_JSON_FILE)) {
      const content = fs.readFileSync(LOGS_JSON_FILE, 'utf-8');
      try {
        reports = JSON.parse(content);
      } catch (e) {}
    }
    reports = reports.filter(r => r.scan_time !== report.scan_time);
    reports.unshift(report); // Newest first
    
    if (reports.length > 200) {
      reports = reports.slice(0, 200);
    }
    fs.writeFileSync(LOGS_JSON_FILE, JSON.stringify(reports, null, 2), 'utf-8');
  } catch (err: any) {
    console.error(`❌ Failed to write hourly report log JSON file:`, err.message);
  }
}

/**
 * Load all historical hourly reports
 */
export function loadLocalHourlyReports(): HourlyReport[] {
  try {
    if (fs.existsSync(LOGS_JSON_FILE)) {
      const content = fs.readFileSync(LOGS_JSON_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {}
  return [];
}

/**
 * Loads all jobs from PostgreSQL if available
 */
export async function dbLoadJobs(): Promise<ScrapedJob[]> {
  if (!isPgAvailable || !pool) return [];
  try {
    const res = await pool.query('SELECT * FROM jobs_discovery ORDER BY last_seen_timestamp DESC');
    return res.rows.map((row: any) => ({
      job_id: row.job_id,
      company_name: row.company_name,
      company_website: row.company_website,
      career_page_url: row.career_page_url,
      job_title: row.job_title,
      job_url: row.job_url,
      location: row.location,
      city: row.city,
      state: row.state,
      country: row.country,
      work_mode: row.work_mode,
      employment_type: row.employment_type,
      experience_required: row.experience_required,
      skills: row.skills || [],
      department: row.department,
      posted_date: row.posted_date,
      application_deadline: row.application_deadline,
      status: row.status as 'OPEN' | 'CLOSED',
      source_type: row.source_type as 'OFFICIAL' | 'THIRD_PARTY',
      source_name: row.source_name,
      first_seen_timestamp: row.first_seen_timestamp,
      last_seen_timestamp: row.last_seen_timestamp,
      description: row.description,
      apply_url: row.apply_url,

      // AI fields
      ai_confidence:    row.ai_confidence ?? undefined,
      ai_model_used:    row.ai_model_used ?? undefined,
      ai_extracted:     row.ai_extracted ?? false,
      review_needed:    row.review_needed ?? false,
      match_score:      row.match_score ?? undefined,
      freshness_score:  row.freshness_score ?? undefined,
      composite_score:  row.composite_score ?? undefined,
      tags:             row.tags ?? [],
      salary_range:     row.salary_range ?? '',
      language:         row.language ?? 'en',
      skill_matches:    row.skill_matches ?? [],
      skill_gaps:       row.skill_gaps ?? [],
      match_explanation: row.match_explanation ?? '',

      // Compatibility mapping
      id: row.job_id,
      title: row.job_title,
      companyName: row.company_name,
      url: row.job_url,
      scrapedAt: row.last_seen_timestamp,
      postedDate: row.posted_date,
      remote: row.work_mode === 'remote',
      salary: row.salary_range ?? '',
    }));
  } catch (err: any) {
    console.error('❌ Failed to load jobs from PostgreSQL:', err.message);
    return [];
  }
}

/**
 * Loads the last 200 hourly reports from PostgreSQL if available
 */
export async function dbLoadHourlyReports(): Promise<HourlyReport[]> {
  if (!isPgAvailable || !pool) return [];
  try {
    const res = await pool.query('SELECT * FROM hourly_reports ORDER BY scan_time DESC LIMIT 200');
    return res.rows.map((row: any) => ({
      scan_time: row.scan_time,
      new_jobs_found: row.new_jobs_found,
      updated_jobs_found: row.updated_jobs_found,
      closed_jobs_found: row.closed_jobs_found,
      duplicate_jobs_skipped: row.duplicate_jobs_skipped,
      companies_scanned: row.companies_scanned
    }));
  } catch (err: any) {
    console.error('❌ Failed to load hourly reports from PostgreSQL:', err.message);
    return [];
  }
}

/**
 * Clears all job discovery data in PostgreSQL if available
 */
export async function dbClearJobs(): Promise<void> {
  if (!isPgAvailable || !pool) return;
  try {
    await pool.query('TRUNCATE TABLE jobs_discovery CASCADE');
    await pool.query('TRUNCATE TABLE hourly_reports CASCADE');
    console.log('🧹 PostgreSQL jobs_discovery and hourly_reports tables cleared.');
  } catch (err: any) {
    console.error('❌ Failed to clear tables in PostgreSQL:', err.message);
  }
}
