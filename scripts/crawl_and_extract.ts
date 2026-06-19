import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { 
  ScrapedJob, 
  getScratchDir, 
  isPgAvailable, 
  pool as dbPool, 
  dbUpsertJob, 
  dbUpsertAiJob,
  dbLoadJobs
} from '../src/lib/db';
import { generateJobFingerprint, loadJobState, saveJobState } from '../src/lib/job-scraper';

const SCRATCH_DIR = getScratchDir();
const STATE_FILE = path.join(SCRATCH_DIR, 'scraper_progress.json');
const ENV_FILE = path.join(__dirname, '..', '.env.local');

// Load environment variables
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  });
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

interface ScrapedCompany {
  name: string;
  website: string;
  careers: string;
  status: string;
  verified?: boolean;
}

// Check location for India keywords
function isIndiaLocation(loc: string): boolean {
  if (!loc) return false;
  const l = loc.toLowerCase();
  const keywords = ['india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'chennai', 'mumbai', 'noida', 'gurgaon', 'gurugram', 'kolkata', 'kochi', 'delhi', 'ahmedabad', 'remote'];
  return keywords.some(k => l.includes(k));
}

// Fetch Greenhouse jobs
async function fetchGreenhouse(slug: string): Promise<any[]> {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter((j: any) => isIndiaLocation(j.location?.name || ''))
      .map((j: any) => ({
        title: j.title || '',
        url: j.absolute_url || '',
        description: (j.content || '').replace(/<[^>]+>/g, '').slice(0, 500),
        location: j.location?.name || 'India',
        source: 'Greenhouse'
      }));
  } catch (e) {
    return [];
  }
}

// Fetch Lever jobs
async function fetchLever(slug: string): Promise<any[]> {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json&state=published`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter((j: any) => isIndiaLocation(j.categories?.location || ''))
      .map((j: any) => ({
        title: j.text || '',
        url: j.hostedUrl || '',
        description: (j.descriptionPlain || '').slice(0, 500),
        location: j.categories?.location || j.workplaceType || 'India',
        source: 'Lever'
      }));
  } catch (e) {
    return [];
  }
}

// Fetch Ashby jobs
async function fetchAshby(slug: string): Promise<any[]> {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobPostings || [])
      .filter((j: any) => isIndiaLocation(j.location || j.locationName || ''))
      .map((j: any) => ({
        title: j.title || '',
        url: `https://jobs.ashbyhq.com/${slug}/${j.id}`,
        description: (j.descriptionSafe || '').replace(/<[^>]+>/g, '').slice(0, 500),
        location: j.location || j.locationName || 'India',
        source: 'Ashby'
      }));
  } catch (e) {
    return [];
  }
}

// Fetch SmartRecruiters jobs
async function fetchSmartRecruiters(slug: string): Promise<any[]> {
  try {
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?country=IN&status=ACTIVE&limit=50`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.content || []).map((j: any) => ({
      title: j.name || '',
      url: `https://careers.smartrecruiters.com/${slug}/${j.id}`,
      description: (j.jobAd?.sections?.companyDescription?.text || '').replace(/<[^>]+>/g, '').slice(0, 500),
      location: j.location?.city ? `${j.location.city}, India` : 'India',
      source: 'SmartRecruiters'
    }));
  } catch (e) {
    return [];
  }
}

// Direct HTML scraper fallback
async function scrapeDirectHtml(url: string, companyName: string): Promise<any[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const html = await res.text();
    
    // Check if Greenhouse/Lever is embedded in HTML
    if (html.includes('greenhouse.io')) {
      const match = html.match(/boards\.greenhouse\.io\/(?:embed\/job_board\?for=|v1\/boards\/|)([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const jobs = await fetchGreenhouse(match[1]);
        if (jobs.length > 0) return jobs;
      }
    }
    if (html.includes('lever.co')) {
      const match = html.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const jobs = await fetchLever(match[1]);
        if (jobs.length > 0) return jobs;
      }
    }
    if (html.includes('ashbyhq.com')) {
      const match = html.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const jobs = await fetchAshby(match[1]);
        if (jobs.length > 0) return jobs;
      }
    }

    // Heuristically extract anchor tags with titles containing common job keywords
    const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const jobs: any[] = [];
    const jobKeywords = ['engineer', 'developer', 'designer', 'analyst', 'manager', 'lead', 'intern', 'specialist', 'architect', 'hiring', 'opportunity', 'consultant'];
    const seenUrls = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1].trim();
      const text = match[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
      
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      if (seenUrls.has(href)) continue;

      const isJobLink = jobKeywords.some(kw => text.includes(kw)) && 
                        !href.includes('linkedin.com') && 
                        !href.includes('twitter.com') && 
                        !href.includes('facebook.com');

      if (isJobLink) {
        try {
          const absoluteUrl = new URL(href, url).href;
          seenUrls.add(href);
          jobs.push({
            title: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
            url: absoluteUrl,
            description: `Apply for this position directly at ${companyName}.`,
            location: 'India',
            source: 'Heuristic HTML Scraper'
          });
        } catch (e) {}
      }
    }

    return jobs;
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('============================================================');
  console.log('🏁 STARTING ENTERPRISE JOB SCRAPER SWEEP');
  console.log('============================================================\n');

  // Load companies
  if (!fs.existsSync(STATE_FILE)) {
    console.error('❌ No scraper progress state file found at:', STATE_FILE);
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const companies: ScrapedCompany[] = state.companies || [];
  console.log(`📋 Loaded ${companies.length} target companies.`);

  // Load existing jobs for deduplication
  let existingJobs: ScrapedJob[] = [];
  if (isPgAvailable && dbPool) {
    existingJobs = await dbLoadJobs();
  } else {
    existingJobs = loadJobState().jobs;
  }
  
  const existingFingerprints = new Set(existingJobs.map(j => j.job_id));
  console.log(`🔒 Loaded ${existingFingerprints.size} existing job fingerprints for deduplication.`);

  let totalScanned = 0;
  let totalNewJobs = 0;
  let totalDuplicatesSkipped = 0;

  // Let's run a crawl over the first 50 companies (or limit to speed up test execution)
  const LIMIT = 30;
  const targetCompanies = companies.filter(c => c.careers && c.careers !== 'N/A').slice(0, LIMIT);
  console.log(`🚀 Sweeping the first ${targetCompanies.length} companies...`);

  for (const company of targetCompanies) {
    totalScanned++;
    console.log(`\n🏢 [${totalScanned}/${targetCompanies.length}] Processing "${company.name}"...`);
    console.log(`   Careers URL: ${company.careers}`);
    
    let jobs: any[] = [];

    // 1. Direct ATS slug detection from URL
    try {
      const urlObj = new URL(company.careers);
      const host = urlObj.hostname.toLowerCase();
      const pathname = urlObj.pathname;
      const parts = pathname.split('/').filter(Boolean);

      if (host.includes('greenhouse.io') && parts[0]) {
        console.log(`   detected Greenhouse direct board slug: ${parts[0]}`);
        jobs = await fetchGreenhouse(parts[0]);
      } else if (host.includes('lever.co') && parts[0]) {
        console.log(`   detected Lever direct board slug: ${parts[0]}`);
        jobs = await fetchLever(parts[0]);
      } else if (host.includes('ashbyhq.com') && parts[0]) {
        console.log(`   detected Ashby direct board slug: ${parts[0]}`);
        jobs = await fetchAshby(parts[0]);
      } else if (host.includes('smartrecruiters.com') && parts[0]) {
        console.log(`   detected SmartRecruiters direct board slug: ${parts[0]}`);
        jobs = await fetchSmartRecruiters(parts[0]);
      } else {
        // Fallback to scraping careers page and embedding detection
        console.log(`   generic URL, parsing HTML...`);
        jobs = await scrapeDirectHtml(company.careers, company.name);
      }
    } catch (e: any) {
      console.warn(`   ⚠️ Error parsing careers URL: ${e.message}`);
    }

    if (jobs.length === 0) {
      console.log(`   ⚠️ No jobs extracted for "${company.name}".`);
      continue;
    }

    console.log(`   Found ${jobs.length} jobs. Normalizing and saving...`);

    let newJobsForCompany = 0;

    for (const job of jobs) {
      const fingerprint = generateJobFingerprint({
        job_url: job.url,
        company_name: company.name,
        job_title: job.title,
        location: job.location
      });

      if (existingFingerprints.has(fingerprint)) {
        totalDuplicatesSkipped++;
        continue;
      }

      // Build standard ScrapedJob
      const scrapedJob: ScrapedJob = {
        job_id: fingerprint,
        job_fingerprint: fingerprint,
        company_name: company.name,
        company_website: company.website,
        career_page_url: company.careers,
        job_title: job.title,
        job_url: job.url,
        location: job.location,
        city: '',
        state: '',
        country: 'India',
        work_mode: job.title.toLowerCase().includes('remote') ? 'remote' : 'onsite',
        employment_type: 'full-time',
        experience_required: '',
        skills: [],
        department: '',
        posted_date: new Date().toISOString(),
        application_deadline: '',
        status: 'OPEN',
        source_type: 'OFFICIAL',
        source_name: job.source || 'Careers Crawler',
        first_seen_timestamp: new Date().toISOString(),
        last_seen_timestamp: new Date().toISOString(),
        description: job.description,
        apply_url: job.url,
        
        // Compatibility
        id: fingerprint,
        title: job.title,
        companyName: company.name,
        url: job.url,
        scrapedAt: new Date().toISOString(),
        postedDate: new Date().toISOString(),
        remote: job.title.toLowerCase().includes('remote')
      };

      existingFingerprints.add(fingerprint);
      newJobsForCompany++;
      totalNewJobs++;

      // Save job
      if (isPgAvailable && dbPool) {
        await dbUpsertJob(scrapedJob);
      } else {
        const localState = loadJobState();
        localState.jobs.push(scrapedJob);
        saveJobState(localState);
      }
    }

    console.log(`   ✅ Added ${newJobsForCompany} new jobs to tracker.`);
  }

  console.log('\n============================================================');
  console.log('🏁 CRAWL COMPLETED');
  console.log(`- Companies Scanned: ${totalScanned}`);
  console.log(`- New Jobs Discovered: ${totalNewJobs}`);
  console.log(`- Duplicate Jobs Skipped: ${totalDuplicatesSkipped}`);
  console.log('============================================================');
  
  if (isPgAvailable && dbPool) {
    await dbPool.end();
  }
}

main().catch(console.error);
