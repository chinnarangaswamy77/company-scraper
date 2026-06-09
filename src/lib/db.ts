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

  // Compatibility fields for the page.tsx UI
  id?: string;
  title?: string;
  companyName?: string;
  url?: string;
  scrapedAt?: string;
  postedDate?: string;
  remote?: boolean;
  salary?: string;
  salary_range?: string;
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

let pool: pg.Pool | null = null;
export let isPgAvailable = false;

if (process.env.PG_CONN_STRING) {
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

/**
 * Ensures tables are set up in PostgreSQL if available
 */
export async function initDatabase() {
  if (!isPgAvailable || !pool) return;
  try {
    const client = await pool.connect();
    try {
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

      // Compatibility mapping
      id: row.job_id,
      title: row.job_title,
      companyName: row.company_name,
      url: row.job_url,
      scrapedAt: row.last_seen_timestamp,
      postedDate: row.posted_date,
      remote: row.work_mode === 'remote',
      salary: '',
      salary_range: ''
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
