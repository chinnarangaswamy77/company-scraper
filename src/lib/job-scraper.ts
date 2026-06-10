import fs from 'fs';
import path from 'path';
import { 
  dbUpsertJob, 
  dbSaveHourlyReport, 
  exportToCSV, 
  saveRawScrapeLog,
  saveLocalHourlyReport, 
  loadLocalHourlyReports,
  initDatabase, 
  ScrapedJob, 
  HourlyReport,
  getScratchDir,
  dbLoadJobs,
  dbClearJobs,
  isPgAvailable
} from './db';

export interface JobScrapeState {
  status: 'idle' | 'running' | 'completed';
  lastRunTime: string | null;
  nextRunTime: string | null;
  jobs: ScrapedJob[];
  logs: string[];
}

const JOBS_FILE = path.join(getScratchDir(), 'jobs_data.json');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15'
];

let inMemoryJobState: JobScrapeState | null = null;
let isCurrentlyScraping = false;

export function loadJobState(): JobScrapeState {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const content = fs.readFileSync(JOBS_FILE, 'utf-8');
      inMemoryJobState = JSON.parse(content);
      
      if (inMemoryJobState) {
        if (inMemoryJobState.jobs) {
          // Normalize and filter out duplicates completely
          const seenGroups = new Set<string>();
          const seenFingerprints = new Set<string>();
          const seenUrls = new Set<string>();
          let hasDuplicates = false;

          const originalCount = inMemoryJobState.jobs.length;

          inMemoryJobState.jobs = inMemoryJobState.jobs
            .map(j => normalizeExistingJobSchema(j))
            .filter(j => {
              if (j.is_duplicate || j.isDuplicate) {
                hasDuplicates = true;
                return false;
              }
              const cleanUrl = j.job_url.split('?')[0].toLowerCase();
              const cleanApplyUrl = j.apply_url ? j.apply_url.split('?')[0].toLowerCase() : '';
              if (seenUrls.has(cleanUrl) || (cleanApplyUrl && seenUrls.has(cleanApplyUrl)) || seenFingerprints.has(j.job_id)) {
                hasDuplicates = true;
                return false;
              }
              const normTitle = j.job_title.toLowerCase().replace(/\s+/g, '');
              const normCompany = normalizeCompanyName(j.company_name).toLowerCase();
              const normLoc = j.location.toLowerCase().replace(/\s+/g, '');
              const groupKey = `${normCompany}|${normTitle}|${normLoc}`;
              if (seenGroups.has(groupKey)) {
                hasDuplicates = true;
                return false;
              }
              
              seenUrls.add(cleanUrl);
              if (cleanApplyUrl) seenUrls.add(cleanApplyUrl);
              seenFingerprints.add(j.job_id);
              seenGroups.add(groupKey);
              return true;
            });

          // Save cleaned state back to file if any duplicates were removed
          if (hasDuplicates || inMemoryJobState.jobs.length !== originalCount) {
            console.log(`🧹 Cleaned database: removed ${originalCount - inMemoryJobState.jobs.length} duplicate jobs.`);
            try {
              fs.writeFileSync(JOBS_FILE, JSON.stringify(inMemoryJobState, null, 2), 'utf-8');
            } catch (err: any) {
              console.error('Failed to auto-prune duplicates:', err.message);
            }
          }
        }
        if (inMemoryJobState.status === 'running' && !isCurrentlyScraping) {
          inMemoryJobState.status = 'idle';
        }
      }
      return inMemoryJobState!;
    }
  } catch (error) {
    console.error('Failed to load jobs state file:', error);
  }

  inMemoryJobState = {
    status: 'idle',
    lastRunTime: null,
    nextRunTime: null,
    jobs: [],
    logs: ['Jobs Discovery Agent database initialized.']
  };
  saveJobState(inMemoryJobState);
  return inMemoryJobState;
}

export function saveJobState(state: JobScrapeState) {
  inMemoryJobState = state;
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save jobs state file:', error);
  }
}

function logJobMessage(state: JobScrapeState, message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const log = `[${timestamp}] ${message}`;
  state.logs.push(log);
  if (state.logs.length > 200) {
    state.logs.shift();
  }
}

// Global scope tracker to prevent duplicate cron interval runs on hot reloads
const globalWithCron = global as typeof globalThis & {
  backgroundCronInterval?: NodeJS.Timeout;
  currentIntervalMinutes?: number;
};

export function startJobScraperCron() {
  if (globalWithCron.currentIntervalMinutes === 10 && globalWithCron.backgroundCronInterval) {
    return;
  }

  if (globalWithCron.backgroundCronInterval) {
    clearInterval(globalWithCron.backgroundCronInterval);
  }

  const state = loadJobState();
  
  const scheduleNextRun = () => {
    state.nextRunTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    saveJobState(state);
  };
  
  if (!state.nextRunTime || globalWithCron.currentIntervalMinutes !== 10) {
    scheduleNextRun();
  }

  logJobMessage(state, '⏰ 10-Minute background Job Discovery Agent started.');
  saveJobState(state);

  globalWithCron.backgroundCronInterval = setInterval(async () => {
    const currentState = loadJobState();
    currentState.lastRunTime = new Date().toISOString();
    currentState.nextRunTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    saveJobState(currentState);
    
    try {
      await runJobScraper();
    } catch (err: any) {
      console.error('10-minute job discovery run failed:', err.message);
    }
  }, 10 * 60 * 1000); // 10 minutes

  globalWithCron.currentIntervalMinutes = 10;
}

export function stopJobScraperCron() {
  if (globalWithCron.backgroundCronInterval) {
    clearInterval(globalWithCron.backgroundCronInterval);
    globalWithCron.backgroundCronInterval = undefined;
  }
  globalWithCron.currentIntervalMinutes = undefined;
  const state = loadJobState();
  logJobMessage(state, '🛑 10-Minute background Job Discovery Agent stopped.');
  saveJobState(state);
}

function cleanHtmlText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes company names to clean up suffix boilerplate
 */
export function normalizeCompanyName(name: string): string {
  return name
    .replace(/\b(Pvt\.?\s*Ltd\.?|Private\s+Limited|Ltd\.?|Limited|Inc\.?|Corporation|Corp\.?|Co\.?|Company)\b/gi, '')
    .replace(/\b(India|Development\s+Centre|R&D\s+Institute|R&D\s+Center|Software\s+Centre|Global\s+Software|Technologies|Solutions|Software|IT\s+Services|Systems)\b/gi, '')
    .replace(/\s*\(.*?\)/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses and extracts Company Name and Job Title from Search Result Title & URL
 */
export function parseCompanyAndTitle(urlStr: string, titleStr: string): { company: string; title: string } {
  let company = '';
  let title = '';

  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    
    if (host.includes('lever.co')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) company = parts[0];
    } else if (host.includes('greenhouse.io')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0 && parts[0] !== 'embed') {
        company = parts[0];
      } else {
        const forCompany = url.searchParams.get('for');
        if (forCompany) company = forCompany;
      }
    } else if (host.includes('myworkdayjobs.com')) {
      const hostParts = url.hostname.split('.');
      if (hostParts.length > 0 && hostParts[0] !== 'www') {
        company = hostParts[0].replace(/-careers$/, '');
      }
    } else if (host.includes('instahyre.com')) {
      const match = url.pathname.match(/-at-([a-z0-9-]+)/i);
      if (match) company = match[1].replace(/-/g, ' ');
    } else if (host.includes('wellfound.com')) {
      const match = url.pathname.match(/-at-([a-z0-9-]+)/i);
      if (match) company = match[1].replace(/-/g, ' ');
    } else if (host.includes('ycombinator.com')) {
      const match = url.pathname.match(/-at-([a-z0-9-]+)/i);
      if (match) company = match[1].replace(/-/g, ' ');
    } else if (host.includes('cutshort.io')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 1 && parts[0] === 'job') {
        const subParts = parts[1].split('-');
        if (subParts.length >= 3) {
          const companyPart = subParts[subParts.length - 2];
          company = companyPart;
          
          const cities = ['bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'noida', 'gurgaon', 'gurugram', 'chennai', 'kochi', 'trivandrum', 'delhi', 'india', 'remote', 'wfh'];
          const titleParts = subParts.slice(0, subParts.length - 2).filter(p => !cities.includes(p.toLowerCase()));
          title = titleParts.join(' ');
        }
      }
    } else if (host.includes('hirist.tech') || host.includes('hirist.com')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 1 && parts[0] === 'j') {
        const subParts = parts[1].replace('.html', '').split('-');
        if (subParts.length >= 2) {
          const titleParts = subParts.slice(0, subParts.length - 1);
          title = titleParts.join(' ');
        }
      }
    }
  } catch (e) {}

  const cleanTitle = titleStr
    .replace(/-\s*(Indeed|LinkedIn|Glassdoor|Monster|Foundit|Naukri|Monster India|Monster-India|Wellfound|Instahyre|Cutshort|Hirist).*/i, '')
    .replace(/\|\s*(Indeed|LinkedIn|Glassdoor|Monster|Foundit|Naukri|Monster India|Monster-India|Wellfound|Instahyre|Cutshort|Hirist).*/i, '')
    .trim();

  let parsedTitle = title || cleanTitle;
  let parsedCompany = company;

  if (cleanTitle.includes(' at ')) {
    const parts = cleanTitle.split(/\b\s+at\s+\b/i);
    if (!title) parsedTitle = parts[0].trim();
    if (!parsedCompany) parsedCompany = parts[1].trim();
  } else if (cleanTitle.includes(' - ')) {
    const parts = cleanTitle.split(/\s+-\s+/);
    if (parts.length >= 2) {
      const part1IsTitle = /(engineer|developer|designer|manager|analyst|intern|lead|qa|sdet)/i.test(parts[0]);
      if (part1IsTitle) {
        if (!title) parsedTitle = parts[0].trim();
        if (!parsedCompany) parsedCompany = parts[1].trim();
      } else {
        if (!title) parsedTitle = parts[1].trim();
        if (!parsedCompany) parsedCompany = parts[0].trim();
      }
    }
  } else if (cleanTitle.includes(' | ')) {
    const parts = cleanTitle.split(/\s+\|\s+/);
    if (parts.length >= 2) {
      const part1IsTitle = /(engineer|developer|designer|manager|analyst|intern|lead|qa|sdet)/i.test(parts[0]);
      if (part1IsTitle) {
        if (!title) parsedTitle = parts[0].trim();
        if (!parsedCompany) parsedCompany = parts[1].trim();
      } else {
        if (!title) parsedTitle = parts[1].trim();
        if (!parsedCompany) parsedCompany = parts[0].trim();
      }
    }
  } else if (/hiring/i.test(cleanTitle)) {
    const match = cleanTitle.match(/(.*?)\s+hiring\s+(.*)/i);
    if (match) {
      if (!parsedCompany) parsedCompany = match[1].trim();
      if (!title) parsedTitle = match[2].trim();
    }
  }

  parsedTitle = parsedTitle
    .replace(/\s*(?:India|Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Delhi|Noida|Gurgaon|Gurugram|Chennai|Kochi|Trivandrum|Remote)\b/gi, '')
    .replace(/[^a-zA-Z0-9\s+#\-\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!parsedCompany) {
    parsedCompany = 'Live Discovered Co';
  }

  parsedCompany = parsedCompany
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim();

  return {
    company: parsedCompany || 'Live Discovered Co',
    title: parsedTitle || cleanTitle
  };
}

function extractUrlsFromSearchHtml(html: string): { url: string; title: string; description: string }[] {
  const results: { url: string; title: string; description: string }[] = [];
  
  const ddgRegex = /class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = ddgRegex.exec(html)) !== null) {
    let url = match[1];
    let title = match[2];

    if (url.includes('uddg=')) {
      const uddgMatch = /uddg=([^&"' >]+)/.exec(url);
      if (uddgMatch) {
        try {
          url = decodeURIComponent(uddgMatch[1]);
        } catch (e) {}
      }
    }

    let description = '';
    const index = html.indexOf(match[0]);
    if (index !== -1) {
      const remaining = html.substring(index, index + 1500);
      const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(remaining);
      if (snippetMatch) {
        description = cleanHtmlText(snippetMatch[1]);
      }
    }

    if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
      results.push({ url, title: cleanHtmlText(title), description });
    }
  }

  const yahooRegex = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<h3[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>[\s\S]*?<\/h3>\s*<\/a>/g;
  while ((match = yahooRegex.exec(html)) !== null) {
    let url = match[1];
    const title = match[2];

    if (url.includes('RU=')) {
      const ruMatch = /RU=([^/&"' >]+)/.exec(url);
      if (ruMatch) {
        try {
          url = decodeURIComponent(ruMatch[1]);
        } catch (e) {}
      }
    }

    let description = '';
    const index = html.indexOf(match[0]);
    if (index !== -1) {
      const remaining = html.substring(index, index + 1500);
      const snippetMatch = /<div class="compText aWrap[^"]*">([\s\S]*?)<\/div>/i.exec(remaining);
      if (snippetMatch) {
        description = cleanHtmlText(snippetMatch[1]);
      }
    }

    if (url.startsWith('http') && !url.includes('yahoo.com')) {
      results.push({ url, title: cleanHtmlText(title), description });
    }
  }

  return results;
}

async function queryDDGJobs(query: string): Promise<{ url: string; title: string; description: string }[]> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://html.duckduckgo.com/html/`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://html.duckduckgo.com/'
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`DDG status ${response.status}`);
  const html = await response.text();
  return extractUrlsFromSearchHtml(html);
}

async function queryYahooJobs(query: string): Promise<{ url: string; title: string; description: string }[]> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&n=10`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://search.yahoo.com/'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`Yahoo status ${response.status}`);
  const html = await response.text();
  return extractUrlsFromSearchHtml(html);
}

// ─────────────────────────────────────────────────────────────
//  DIRECT ATS & JOB-BOARD API FETCHERS
// ─────────────────────────────────────────────────────────────

type JobItem = { url: string; title: string; description: string; location: string; sourceName?: string; companyName?: string };

function isIndiaLocation(loc: string): boolean {
  if (!loc) return true; // include if unknown
  const l = loc.toLowerCase();
  return l.includes('india') || l.includes('bengaluru') || l.includes('bangalore') ||
    l.includes('hyderabad') || l.includes('pune') || l.includes('mumbai') ||
    l.includes('chennai') || l.includes('noida') || l.includes('gurugram') ||
    l.includes('gurgaon') || l.includes('kochi') || l.includes('delhi') ||
    l.includes('kolkata') || l.includes('remote') || l.includes('wfh') ||
    l.includes('hybrid') || l === '';
}

/** Greenhouse public JSON API */
async function fetchGreenhouseJobs(companySlug: string): Promise<JobItem[]> {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs?content=true`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter((j: any) => isIndiaLocation(j.location?.name || ''))
      .map((j: any) => ({
        url: j.absolute_url || '',
        title: j.title || '',
        description: (j.content || '').replace(/<[^>]+>/g, '').slice(0, 500),
        location: j.location?.name || 'India',
        sourceName: 'Greenhouse',
        companyName: companySlug.replace(/-/g, ' ')
      })).filter((j: JobItem) => j.url && j.title);
  } catch { return []; }
}

/** Lever public JSON API */
async function fetchLeverJobs(companySlug: string): Promise<JobItem[]> {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${companySlug}?mode=json&state=published`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter((j: any) => isIndiaLocation(j.categories?.location || ''))
      .map((j: any) => ({
        url: j.hostedUrl || '',
        title: j.text || '',
        description: (j.descriptionPlain || '').slice(0, 500),
        location: j.categories?.location || j.workplaceType || 'India',
        sourceName: 'Lever',
        companyName: companySlug.replace(/-/g, ' ')
      })).filter((j: JobItem) => j.url && j.title);
  } catch { return []; }
}

/** Ashby public posting API */
async function fetchAshbyJobs(companySlug: string): Promise<JobItem[]> {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${companySlug}`, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobPostings || [])
      .filter((j: any) => isIndiaLocation(j.location || j.locationName || ''))
      .map((j: any) => ({
        url: `https://jobs.ashbyhq.com/${companySlug}/${j.id}`,
        title: j.title || '',
        description: (j.descriptionSafe || '').replace(/<[^>]+>/g, '').slice(0, 500),
        location: j.location || j.locationName || 'India',
        sourceName: 'Ashby',
        companyName: companySlug.replace(/-/g, ' ')
      })).filter((j: JobItem) => j.url && j.title);
  } catch { return []; }
}

/** SmartRecruiters public search API – no key needed for public postings */
async function fetchSmartRecruitersJobs(companySlug: string): Promise<JobItem[]> {
  try {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${companySlug}/postings?country=IN&status=ACTIVE&limit=50`,
      { headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.content || []).map((j: any) => ({
      url: `https://careers.smartrecruiters.com/${companySlug}/${j.id}`,
      title: j.name || '',
      description: (j.jobAd?.sections?.companyDescription?.text || '').replace(/<[^>]+>/g, '').slice(0, 500),
      location: j.location?.city ? `${j.location.city}, India` : 'India',
      sourceName: 'SmartRecruiters',
      companyName: companySlug.replace(/-/g, ' ')
    })).filter((j: JobItem) => j.url && j.title);
  } catch { return []; }
}

/** Remotive free public API – remote-friendly India roles */
async function fetchRemotiveJobs(search: string): Promise<JobItem[]> {
  try {
    const res = await fetch(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(search)}&limit=50`,
      { headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter((j: any) => {
        const loc = (j.candidate_required_location || '').toLowerCase();
        return !loc || loc.includes('india') || loc.includes('worldwide') ||
          loc.includes('asia') || loc.includes('anywhere') || loc === '';
      })
      .map((j: any) => ({
        url: j.url || '',
        title: j.title || '',
        description: (j.description || '').replace(/<[^>]+>/g, '').slice(0, 500),
        location: j.candidate_required_location || 'Remote',
        sourceName: 'Remotive',
        companyName: j.company_name || ''
      })).filter((j: JobItem) => j.url && j.title);
  } catch { return []; }
}

/** Parse simple RSS/Atom XML without any library */
function parseRSSItems(xml: string): { title: string; link: string; description: string; pubDate: string }[] {
  const items: { title: string; link: string; description: string; pubDate: string }[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const found = r.exec(block);
      return found ? found[1].trim() : '';
    };
    const linkAlt = /<link[^>]*>\s*(https?:[^\s<]+)/i.exec(block);
    items.push({
      title: get('title'),
      link: get('link') || (linkAlt ? linkAlt[1] : ''),
      description: get('description').replace(/<[^>]+>/g, '').slice(0, 500),
      pubDate: get('pubDate')
    });
  }
  return items;
}

/** Indeed India public RSS feeds – no API key needed */
async function fetchIndeedRSS(role: string, location: string = 'India'): Promise<JobItem[]> {
  try {
    const url = `https://in.indeed.com/rss?q=${encodeURIComponent(role)}&l=${encodeURIComponent(location)}&sort=date&limit=50`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => ({
        url: i.link,
        title: i.title,
        description: i.description,
        location,
        sourceName: 'Indeed',
        companyName: (() => {
          const m = /\bat\s+(.+?)(?:\s*[-|]|$)/i.exec(i.title);
          return m ? m[1].trim() : '';
        })()
      }));
  } catch { return []; }
}

/** Naukri RSS feeds – public, no auth needed */
async function fetchNaukriRSS(role: string, city: string = ''): Promise<JobItem[]> {
  try {
    const slug = role.toLowerCase().replace(/\s+/g, '-');
    const citySlug = city.toLowerCase().replace(/\s+/g, '-');
    const url = city
      ? `https://www.naukri.com/rss/jobs/${slug}-jobs-in-${citySlug}.rss`
      : `https://www.naukri.com/rss/jobs/${slug}-jobs.rss`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[2], 'Accept': 'application/rss+xml, text/xml' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => ({
        url: i.link,
        title: i.title,
        description: i.description,
        location: city || 'India',
        sourceName: 'Naukri',
        companyName: (() => {
          const m = /\bat\s+(.+?)(?:\s*[-|]|$)/i.exec(i.title);
          return m ? m[1].trim() : '';
        })()
      }));
  } catch { return []; }
}

/** TimesJobs RSS – public */
async function fetchTimesJobsRSS(role: string): Promise<JobItem[]> {
  try {
    const url = `https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=${encodeURIComponent(role)}&txtLocation=India&rss=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[1], 'Accept': 'application/rss+xml, text/xml' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => ({
        url: i.link,
        title: i.title,
        description: i.description,
        location: 'India',
        sourceName: 'TimesJobs',
        companyName: (() => {
          const m = /\bat\s+(.+?)(?:\s*[-|]|$)/i.exec(i.title);
          return m ? m[1].trim() : '';
        })()
      }));
  } catch { return []; }
}

/** Shine.com RSS – public */
async function fetchShineRSS(role: string): Promise<JobItem[]> {
  try {
    const url = `https://www.shine.com/job-search/${role.toLowerCase().replace(/\s+/g, '-')}-jobs/?rss=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[1], 'Accept': 'application/rss+xml, text/xml' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => ({
        url: i.link,
        title: i.title,
        description: i.description,
        location: 'India',
        sourceName: 'Shine',
        companyName: (() => {
          const m = /\bat\s+(.+?)(?:\s*[-|]|$)/i.exec(i.title);
          return m ? m[1].trim() : '';
        })()
      }));
  } catch { return []; }
}

/** Freshersworld RSS – public, good for entry-level roles */
async function fetchFreshersworldRSS(role: string): Promise<JobItem[]> {
  try {
    const url = `https://www.freshersworld.com/jobs/rss/${encodeURIComponent(role)}/india`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/rss+xml, text/xml' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => ({
        url: i.link,
        title: i.title,
        description: i.description,
        location: 'India',
        sourceName: 'FreshersWorld',
        companyName: (() => {
          const m = /\bat\s+(.+?)(?:\s*[-|]|$)/i.exec(i.title);
          return m ? m[1].trim() : '';
        })()
      }));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────
//  COMPANY LISTS FOR DIRECT ATS APIS
// ─────────────────────────────────────────────────────────────

/** Companies using Greenhouse with significant India hiring */
const GREENHOUSE_COMPANIES = [
  // Fintech & Payments
  'razorpay', 'phonepe', 'groww', 'cred', 'slice', 'niyo', 'stashfin',
  'lendingkart', 'kissht', 'moneytap', 'kredivo', 'setu', 'perfios',
  'signzy', 'finbox', 'epifi', 'jupiter', 'onecard', 'axio',
  'indmoney', 'smallcase', 'stockal', 'kuvera', 'piggy',
  // E-commerce & D2C
  'meesho', 'zomato', 'bigbasket', 'dunzo', 'cultfit',
  'nykaa', 'purplle', 'mamaearth', 'sugar-cosmetics', 'bombay-shaving',
  'lenskart', 'pepperfry', 'urban-ladder', 'wakefit', 'sleepy-owl',
  // SaaS & B2B
  'freshworks', 'chargebee', 'druva', 'browserstack', 'postman', 'hasura',
  'clevertap', 'darwinbox', 'capillary', 'zoho', 'helpshift', 'exotel',
  'eka', 'facilio', 'klenty', 'haptik', 'gupshup', 'sprinklr',
  'leadsquared', 'moengage', 'webengage', 'netcore', 'kaleyra',
  'icertis', 'o9solutions', 'manthan', 'absolutdata', 'livealth',
  // Healthcare & Biotech
  'mfine', 'practo', 'portea', 'nightingales', 'healthkart',
  'pharmeasy', 'medlife', '1mg', 'pristyn-care', 'cure-fit',
  'docplexus', 'plivo', 'niramai', 'sigtuple', 'qure',
  // Logistics & Supply Chain
  'rivigo', 'blackbuck', 'xpressbees', 'ecom-express', 'shadowfax',
  'delhivery', 'ekart', 'loadshare', 'porter', 'borzo',
  // HR Tech
  'keka', 'greythr', 'springworks', 'kredily', 'akrivia',
  'zimyo', 'hrcloud', 'factset', 'darwinbox', 'beehive',
  // Edtech
  'classplus', 'teachmint', 'convai', 'whiteboard', 'lido',
  // Climate & Energy
  'oye-rickshaw', 'ather', 'ola-electric', 'simple-energy',
  // Global MNCs with India offices
  'twilio', 'stripe', 'plaid', 'brex', 'rippling', 'gusto',
  'lattice', 'culture-amp', 'leapsome', 'personio',
  'contentful', 'algolia', 'miro', 'figma', 'notion',
  'linear', 'loom', 'vercel', 'supabase', 'retool',
  'amplitude', 'mixpanel', 'segment', 'heap', 'fullstory',
  'pagerduty', 'datadog', 'grafana', 'elastic', 'splunk',
  'hashicorp', 'mongodb', 'cockroachdb', 'timescale', 'yugabyte',
  'confluent', 'databricks', 'dbt-labs', 'airbyte', 'fivetran',
  'sentry', 'snyk', 'sonatype', 'aquasecurity', 'lacework',
  'postman', 'insomnia', 'stoplight', 'readme', 'apiary',
  'calendly', 'typeform', 'tally', 'airtable', 'coda',
];

/** Companies using Lever with significant India hiring */
const LEVER_COMPANIES = [
  // Indian Fintech
  'juspay', 'khatabook', 'ofbusiness', 'recko', 'cashfree',
  'cashify', 'dealshare', 'vymo', 'ekincare', 'leadsquared',
  'innovaccer', 'icertis', 'mindtickle', 'unacademy', 'vedantu',
  'byjus', 'toppr', 'doubtnut', 'testbook', 'classplus',
  'licious', 'milkbasket', 'zepto', 'blinkit', 'swiggy',
  'spinny', 'cars24', 'acko', 'digit', 'go-digit',
  'onsurity', 'healthians', 'truemeds', 'medikabazaar',
  // Indian SaaS
  'wingify', 'ozonetel', 'callhippo', 'knowlarity', 'mcube',
  'turtlemint', 'coverfox', 'insurancedekho', 'renewbuy',
  'tracxn', 'yourstory', 'entrackr', 'funding-societies',
  'indiagold', 'rupeek', 'loanzone', 'creditwise',
  // Infra & DevTools
  'hasura', 'appsmith', 'tooljet', 'nocodb', 'baserow',
  'lightdash', 'evidence', 'cube-dev', 'metabase', 'redash',
  // Global companies hiring in India
  'zapier', 'hotjar', 'maze', 'productboard', 'fullstory',
  'pendo', 'userpilot', 'appcues', 'chameleon', 'userflow',
  'remote', 'deel', 'oyster', 'velocity-global', 'rippling',
  'thoughtspot', 'sisense', 'looker', 'mode-analytics', 'sigma',
  'weights-and-biases', 'scale-ai', 'cohere', 'anthropic', 'mistral',
  'huggingface', 'together-ai', 'anyscale', 'modal-labs',
  'dbt', 'elementary', 'lightdash-co', 'transform', 'atlan',
];

/** Companies using Ashby */
const ASHBY_COMPANIES = [
  // Indian product companies
  'razorpay', 'cashfree', 'setu', 'juspay', 'perfios', 'signzy',
  'leadsquared', 'darwinbox', 'chargebee', 'freshworks', 'moengage',
  'groww', 'zepto', 'spinny', 'acko', 'nykaa', 'lenskart',
  'swiggy', 'dunzo', 'blinkit', 'zepto-food', 'milkbasket',
  'khatabook', 'ofbusiness', 'recko', 'vymo', 'mindtickle',
  // Global developer tools
  'linear', 'retool', 'vercel', 'railway', 'supabase', 'planetscale',
  'cal', 'loom', 'coda', 'descript', 'pitch', 'mmhmm',
  'browserstack', 'postman', 'hasura', 'appsmith', 'tooljet',
  'airbyte', 'fivetran', 'segment', 'rudderstack', 'jitsu',
  'sentry', 'highlight', 'grafana', 'signoz', 'last9',
  'posthog', 'mixpanel', 'amplitude', 'heap', 'clarity',
  'cursor', 'codeium', 'tabnine', 'kite', 'codota',
  'dub', 'cal-com', 'trigger', 'inngest', 'temporal',
];

/** Companies using SmartRecruiters */
const SMARTRECRUITERS_COMPANIES = [
  'Wipro', 'TechMahindra', 'HCL-Technologies', 'Mphasis',
  'Hexaware', 'Mastek', 'Kyndryl', 'NTTData', 'CapgeminiIndia',
  'SophosIndia', 'Mediatek', 'Qualcomm', 'Bosch', 'Siemens',
  'Schneider-Electric', 'ABB', 'Honeywell', 'Philips',
  'Ericsson', 'Nokia', 'SAP', 'VMware', 'Cisco', 'HP', 'Dell',
  'Lenovo', 'Hitachi', 'Fujitsu', 'NEC', 'Panasonic', 'Sony',
];

/** Companies with public BambooHR careers pages */
const BAMBOOHR_COMPANIES = [
  // Indian startups
  'razorpay', 'zerodha', 'zeta', 'signzy', 'finvasia',
  'lendingkart', 'stashfin', 'creditbee', 'paytm', 'mobikwik',
  'insurancedekho', 'policybazaar', 'coverfox', 'turtlemint',
  'squad', 'appsmith', 'hasura-io', 'lightdash', 'airbyte',
  // Global companies with India offices
  'intellicheck', 'buildkite', 'close', 'customer-io',
  'ghost', 'glitch', 'buffer', 'doist', 'remote-com', 'basecamp',
  'posthog', 'cal-com', 'plane', 'openbb', 'crowd', 'getdbt',
];

/** Companies with public Workable API */
const WORKABLE_COMPANIES = [
  // Indian product companies
  'browserstack-inc', 'postman-inc', 'moengage', 'webengage',
  'helpshift-inc', 'freshworks-inc', 'zoho-corporation',
  'chargebee-inc', 'clevertap-com', 'exotel-techcom',
  'gupshup-technology', 'haptik-inc', 'instamojo',
  'razorpay-software', 'cashfree-payments', 'juspay-technologies',
  // Global
  'typeform', 'hotjar-limited', 'maze-co', 'userpilot',
  'loom-inc', 'pitch-technologies', 'coda-hq', 'notion-labs',
  'linear-app', 'vercel-inc', 'railway-corp', 'supabase-inc',
];

/** Companies with public Recruitee API */
const RECRUITEE_COMPANIES = [
  // Indian tech companies
  'sprinklr', 'wingify', 'ozonetel', 'turtlemint-jobs',
  'tracxn', 'unacademy-jobs', 'brightchamps', 'vedantu-jobs',
  'ketto', 'milaap', 'wishpond', 'interakt',
  // Global
  'miro-inc', 'monday-com', 'pipedrive', 'chartmogul',
  'rebuy', 'sendbird', 'airtable', 'webflow',
];

// ─────────────────────────────────────────────────────────────
//  ROLE CATEGORIES FOR RSS FEED QUERIES  (expanded)
// ─────────────────────────────────────────────────────────────

const INDIA_ROLE_QUERIES = [
  // Core Engineering
  'software engineer', 'software developer', 'frontend developer', 'backend developer',
  'fullstack developer', 'full stack developer', 'devops engineer', 'data engineer',
  'machine learning engineer', 'ml engineer', 'ai engineer', 'data scientist',
  'android developer', 'ios developer', 'mobile developer', 'react native developer',
  'cloud engineer', 'aws engineer', 'gcp engineer', 'azure engineer',
  'site reliability engineer', 'sre engineer', 'platform engineer',
  'qa engineer', 'sdet', 'automation engineer', 'test engineer',
  'python developer', 'java developer', 'nodejs developer', 'golang developer',
  'ruby developer', 'php developer', 'scala developer', 'kotlin developer',
  'react developer', 'angular developer', 'vue developer', 'typescript developer',
  'database administrator', 'dba', 'sql developer', 'postgresql developer',
  'blockchain developer', 'solidity developer', 'web3 developer',
  'embedded systems engineer', 'firmware engineer', 'vlsi engineer',
  'network engineer', 'security engineer', 'cybersecurity engineer',
  // Data & AI
  'data analyst', 'business analyst', 'bi analyst', 'bi developer',
  'data architect', 'big data engineer', 'spark developer',
  'nlp engineer', 'computer vision engineer', 'deep learning engineer',
  'quantitative analyst', 'research scientist', 'applied scientist',
  // Product & Design
  'product manager', 'senior product manager', 'associate product manager',
  'ux designer', 'ui designer', 'product designer', 'ux researcher',
  'graphic designer', 'motion designer', 'visual designer',
  // Engineering Leadership
  'engineering manager', 'tech lead', 'software architect', 'principal engineer',
  'staff engineer', 'vp engineering', 'cto', 'head of engineering',
  // Sales & Marketing
  'sales engineer', 'account executive', 'account manager', 'growth manager',
  'digital marketing manager', 'seo specialist', 'content writer', 'copywriter',
  'performance marketing', 'brand manager', 'social media manager',
  // Operations & Management
  'operations manager', 'project manager', 'program manager', 'scrum master',
  'agile coach', 'delivery manager', 'it manager', 'infrastructure manager',
  // Finance & Legal
  'finance manager', 'chartered accountant', 'financial analyst', 'controller',
  'tax consultant', 'compliance officer', 'company secretary',
  // HR & People
  'hr manager', 'talent acquisition', 'recruiter', 'people operations',
  'hr business partner', 'compensation analyst',
  // Customer Success
  'customer success manager', 'technical support engineer', 'solutions engineer',
  // Fresher / Intern
  'fresher software engineer', 'graduate engineer trainee', 'intern developer',
  'software intern', 'data science intern', 'product management intern',
  'ux design intern', 'marketing intern',
];

const INDIA_CITIES = [
  'Bengaluru', 'Hyderabad', 'Pune', 'Mumbai', 'Chennai',
  'Noida', 'Gurugram', 'Delhi', 'Kolkata', 'Ahmedabad',
  'Kochi', 'Jaipur', 'Chandigarh', 'Coimbatore', 'Indore',
];


// Classifier helpers
export function extractSkills(title: string, text: string): string[] {
  const combined = `${title} ${text}`;
  const found: string[] = [];
  
  for (const skill of SKILLS_DICT) {
    let regex: RegExp;
    if (['Go', 'ML', 'AI', 'QA', 'C#', 'C++'].includes(skill)) {
      if (skill === 'C#') regex = /\bC#\b/gi;
      else if (skill === 'C++') regex = /\bC\+\+\b/gi;
      else if (skill === 'Go') regex = /\b(Go|Golang)\b/;
      else regex = new RegExp(`\\b${skill}\\b`);
    } else {
      const escaped = skill.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    }
    
    if (regex.test(combined)) {
      found.push(skill);
    }
  }
  return found;
}

export function extractExperience(title: string, text: string): string {
  const combined = `${title} ${text}`.toLowerCase();
  
  const rangeMatch = combined.match(/\b(\d+)\s*(?:to|-)\s*(\d+)\s*(?:years?|yrs?)\b/i);
  if (rangeMatch) {
    return `${rangeMatch[1]}-${rangeMatch[2]} years`;
  }
  
  const plusMatch = combined.match(/\b(\d+)\s*\+\s*(?:years?|yrs?)\b/i);
  if (plusMatch) {
    return `${plusMatch[1]}+ years`;
  }

  const minMatch = combined.match(/\b(?:min|minimum)\s*(\d+)\s*(?:years?|yrs?)\b/i);
  if (minMatch) {
    return `${minMatch[1]}+ years`;
  }

  if (/\b(intern|internship|trainee|apprentice)\b/i.test(combined)) {
    return '0 years (Internship)';
  }
  if (/\b(junior|jr\b|associate|entry|fresh|fresher|graduate)\b/i.test(combined)) {
    return '0-2 years';
  }
  if (/\b(senior|sr\b|lead|principal|architect|manager)\b/i.test(combined)) {
    return '6+ years';
  }
  
  return '3-5 years';
}

export function extractWorkMode(title: string, text: string): string {
  const combined = `${title} ${text}`.toLowerCase();
  if (/\b(remote|wfh|work from home|work-from-home|offsite)\b/i.test(combined)) {
    return 'remote';
  }
  if (/\b(hybrid|flexible work|partial remote)\b/i.test(combined)) {
    return 'hybrid';
  }
  return 'onsite';
}

export function extractEmploymentType(title: string, text: string): string {
  const combined = `${title} ${text}`.toLowerCase();
  if (/\b(intern|internship|trainee)\b/i.test(combined)) {
    return 'internship';
  }
  if (/\b(apprentice|apprenticeship)\b/i.test(combined)) {
    return 'apprenticeship';
  }
  if (/\b(contract|freelance|consultant|contractor)\b/i.test(combined)) {
    return 'contract';
  }
  if (/\b(part-time|part time)\b/i.test(combined)) {
    return 'part-time';
  }
  return 'full-time';
}

export function extractSalary(title: string, text: string): string {
  const combined = `${title} ${text}`;
  const lpaMatch = combined.match(/(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:LPA|Lakhs?|L)\b/i);
  if (lpaMatch) {
    return `₹${lpaMatch[1]} - ${lpaMatch[2]} LPA`;
  }
  const lpaSingleMatch = combined.match(/(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d+)?)\s*(?:LPA|Lakhs?|L)\b/i);
  if (lpaSingleMatch) {
    return `₹${lpaSingleMatch[1]} LPA`;
  }
  const usdMatch = combined.match(/(?:\$)\s*(\d+k?)\s*(?:-|to)\s*(\d+k?)\b/i);
  if (usdMatch) {
    return `$${usdMatch[1]} - $${usdMatch[2]}`;
  }
  return ''; // Quality rule: Leave blank rather than guessing
}

export function parseCityAndState(title: string, text: string, url: string, location: string): { city: string; state: string } {
  const combined = `${title} ${text} ${url} ${location}`.toLowerCase();
  
  if (combined.includes('bengaluru') || combined.includes('bangalore')) {
    return { city: 'Bengaluru', state: 'Karnataka' };
  }
  if (combined.includes('hyderabad')) {
    return { city: 'Hyderabad', state: 'Telangana' };
  }
  if (combined.includes('pune')) {
    return { city: 'Pune', state: 'Maharashtra' };
  }
  if (combined.includes('mumbai')) {
    return { city: 'Mumbai', state: 'Maharashtra' };
  }
  if (combined.includes('noida')) {
    return { city: 'Noida', state: 'Uttar Pradesh' };
  }
  if (combined.includes('gurugram') || combined.includes('gurgaon')) {
    return { city: 'Gurugram', state: 'Haryana' };
  }
  if (combined.includes('chennai')) {
    return { city: 'Chennai', state: 'Tamil Nadu' };
  }
  if (combined.includes('kochi') || combined.includes('cochin')) {
    return { city: 'Kochi', state: 'Kerala' };
  }
  if (combined.includes('trivandrum') || combined.includes('thiruvananthapuram')) {
    return { city: 'Trivandrum', state: 'Kerala' };
  }
  if (combined.includes('kolkata')) {
    return { city: 'Kolkata', state: 'West Bengal' };
  }
  if (combined.includes('delhi')) {
    return { city: 'Delhi', state: 'Delhi' };
  }
  if (combined.includes('remote') || combined.includes('wfh')) {
    return { city: 'Remote', state: 'Remote' };
  }
  return { city: '', state: '' }; // Leave unknown blank as per quality rules!
}

export function isValidJobPage(urlStr: string, titleStr: string): boolean {
  const url = urlStr.toLowerCase();
  const title = titleStr.toLowerCase();

  // Skip pure navigation / meta pages — not actual job listings
  const skipPatterns = [
    '/all-jobs',
    '/jobs-in-',
    '/jobs-for-',
    '/tech-jobs-',
    '/it-jobs-',
    '/aboutus',
    '/about-us',
    '/downloadapp',
    '/sitemap',
    '/contact',
    '/privacy',
    '/terms',
    '/help',
    '/search',
    '/category/',
    '/employers'
  ];
  if (skipPatterns.some(pat => url.includes(pat))) return false;

  // Block pure noise / social / search domains (NOT job boards)
  const noiseDomains = [
    'duckduckgo.com', 'yahoo.com', 'google.com', 'bing.com',
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
    'youtube.com', 'quora.com', 'pinterest.com', 'reddit.com',
    'blogger.com', 'wordpress.com', 'wix.com',
    'medium.com', 'github.com', 'tutorialspoint.com', 'geeksforgeeks.org',
    'upwork.com', 'fiverr.com'
  ];
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (noiseDomains.some(d => host === d || host.endsWith('.' + d))) return false;
    const path = parsed.pathname;
    if (path === '/' || path === '' || path === '/jobs' || path === '/jobs/') return false;
  } catch { return false; }

  // Skip generic list-page titles
  if (/\b\d+\+\s*(jobs|openings|vacancies|results)\b/i.test(title)) return false;
  if (/(dream job|job vacancies|job openings|all jobs|search results)/i.test(title)) return false;

  // Require at least one role keyword in the title so we get actual postings
  const roleKeywords = [
    'developer', 'engineer', 'designer', 'manager', 'analyst', 'lead', 'architect',
    'specialist', 'consultant', 'intern', 'trainee', 'apprentice', 'programmer',
    'sdet', 'qa', 'scrum', 'writer', 'support', 'ops', 'administrator', 'expert',
    'technician', 'officer', 'representative', 'associate', 'fresher', 'devops',
    'data scientist', 'product', 'recruiter', 'hr', 'finance', 'accountant', 'sales'
  ];
  return roleKeywords.some(kw => title.includes(kw));
}

function isPostedWithinLast24Hours(timeText: string): boolean {
  if (!timeText) return true;
  const lower = timeText.toLowerCase();
  if (lower.includes('month') || lower.includes('week') || lower.includes('year')) {
    return false;
  }
  const match = lower.match(/(\d+)\s+days?\s+ago/);
  if (match) {
    const days = parseInt(match[1]);
    if (days > 1) return false;
  }
  return true;
}

async function validateUrlActive(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENTS[0] },
      signal: AbortSignal.timeout(5000)
    });
    if (response.status === 404 || response.status === 410) {
      return false;
    }
    
    if (response.url && (response.url.includes('error=true') || response.url.includes('error='))) {
      return false;
    }
    
    const bodyText = await response.text();
    const lowerBody = bodyText.toLowerCase();

    const deadPhrases = [
      "can't seem to find the page",
      "can’t seem to find the page",
      "we can't find the page",
      "we can’t find the page",
      "page not found",
      "job is not found",
      "job not found",
      "this job is no longer available",
      "no longer accepting applications",
      "position is no longer available",
      "posting has expired",
      "job you are looking for is no longer active",
      "not found or has been closed",
      "careers help center",
      "page you requested was not found",
      "page you requested could not be found",
      "page you requested was not",
      "page you requested is not found",
      "requested was not found"
    ];

    for (const phrase of deadPhrases) {
      if (lowerBody.includes(phrase)) {
        return false;
      }
    }

    return true;
  } catch (e) {
    return true; // Keep if network blocks/timeouts to avoid aggressive drops
  }
}

function isJobExpired(title: string, description: string): boolean {
  const combined = `${title} ${description}`.toLowerCase();
  return /\b(expired|closed|no longer accepting applications|vacancy filled|position filled)\b/i.test(combined);
}

function isStaffingAgency(companyName: string): boolean {
  const lower = companyName.toLowerCase();
  return lower.includes('staffing') || lower.includes('recruitment') || lower.includes('placement') || lower.includes('consultancy');
}

export function generateJobFingerprint(job: {
  job_url: string;
  company_name: string;
  job_title: string;
  location: string;
  posted_date?: string;
}): string {
  const cleanUrl = job.job_url.split('?')[0].toLowerCase();
  const normCompany = normalizeCompanyName(job.company_name).toLowerCase();
  const normTitle = job.job_title.toLowerCase().replace(/\s+/g, '');
  const normLoc = job.location.toLowerCase().replace(/\s+/g, '');

  const raw = `${normCompany}|${normTitle}|${normLoc}|${cleanUrl}`;
  
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 33) ^ raw.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Normalizes old schema models for backward compatibility
 */
function normalizeExistingJobSchema(job: any): ScrapedJob {
  const workMode = job.work_mode || (job.remote ? 'remote' : 'onsite');
  const cityState = parseCityAndState(job.job_title || job.title || '', job.description || '', job.job_url || job.url || '', job.location || '');

  return {
    job_id: job.job_id || job.id || 'N/A',
    job_title: job.job_title || job.title || 'Job Opening',
    company_name: job.company_name || job.companyName || 'Live Discovered Co',
    company_website: job.company_website || '',
    career_page_url: job.career_page_url || job.company_career_page || '',
    job_url: job.job_url || job.url || 'N/A',
    location: job.location || 'India',
    city: job.city || cityState.city,
    state: job.state || cityState.state,
    country: job.country || 'India',
    work_mode: workMode,
    employment_type: job.employment_type || 'full-time',
    experience_required: job.experience_required || job.experience || '3-5 years',
    skills: job.skills || [],
    department: job.department || '',
    posted_date: job.posted_date || job.postedDate || job.scrapedAt || new Date().toISOString(),
    application_deadline: job.application_deadline || '',
    status: job.status === 'CLOSED' || job.status === 'EXPIRED' ? 'CLOSED' : 'OPEN',
    source_type: 'OFFICIAL',
    source_name: job.source_name || job.source || 'Company Careers',
    first_seen_timestamp: job.first_seen_timestamp || job.scrapedAt || new Date().toISOString(),
    last_seen_timestamp: job.last_seen_timestamp || job.scrapedAt || new Date().toISOString(),
    description: job.description || job.job_description || '',
    apply_url: job.apply_url || job.job_url || job.url || '',
    
    // Compatibility keys
    id: job.id || job.job_id || 'N/A',
    title: job.title || job.job_title || 'Job Opening',
    companyName: job.companyName || job.company_name || 'Live Discovered Co',
    url: job.url || job.job_url || 'N/A',
    scrapedAt: job.scrapedAt || job.first_seen_timestamp || new Date().toISOString(),
    postedDate: job.postedDate || job.posted_date || new Date().toISOString(),
    remote: workMode === 'remote',
    salary: job.salary || job.salary_range || '',
    salary_range: job.salary_range || job.salary || '',
    job_fingerprint: job.job_fingerprint || job.job_id || job.id || 'N/A',
    is_duplicate: !!(job.is_duplicate || job.isDuplicate),
    isDuplicate: !!(job.is_duplicate || job.isDuplicate),
    is_seeded: !!(job.is_seeded || job.isSeeded),
    isSeeded: !!(job.is_seeded || job.isSeeded)
  };
}

/**
 * Builds a fully-typed ScrapedJob from a JobItem (ATS API or RSS result).
 */
function buildJobFromAtsItem(
  j: JobItem,
  sourceName: string,
  isJobBoard: boolean
): Omit<ScrapedJob, 'status' | 'first_seen_timestamp' | 'last_seen_timestamp'> {
  const company = j.companyName
    ? j.companyName.replace(/\b\w/g, c => c.toUpperCase())
    : sourceName;
  const cityState = parseCityAndState(j.title, j.description, j.url, j.location);
  const skills = extractSkills(j.title, j.description);
  const workMode = extractWorkMode(j.title, `${j.description} ${j.location}`);
  const empType = extractEmploymentType(j.title, j.description);
  const exp = extractExperience(j.title, j.description);
  const salary = extractSalary(j.title, j.description);
  const fingerprint = generateJobFingerprint({ job_url: j.url, company_name: company, job_title: j.title, location: j.location });

  let careerPageUrl = '';
  try {
    const parsed = new URL(j.url);
    if (sourceName === 'Greenhouse') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      careerPageUrl = `https://boards.greenhouse.io/${parts[0] !== 'embed' ? parts[0] : company.toLowerCase()}`;
    } else if (sourceName === 'Lever') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      careerPageUrl = `https://jobs.lever.co/${parts[0] || company.toLowerCase()}`;
    } else if (sourceName === 'Ashby') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      careerPageUrl = `https://jobs.ashbyhq.com/${parts[0] || company.toLowerCase()}`;
    }
  } catch {}

  return {
    job_id: fingerprint,
    job_title: j.title,
    company_name: company,
    company_website: '',
    career_page_url: careerPageUrl,
    job_url: j.url,
    location: j.location || 'India',
    city: cityState.city,
    state: cityState.state,
    country: 'India',
    work_mode: workMode,
    employment_type: empType,
    experience_required: exp,
    skills,
    department: '',
    salary_range: salary,
    posted_date: new Date().toISOString(),
    application_deadline: '',
    source_type: isJobBoard ? 'THIRD_PARTY' : 'OFFICIAL',
    source_name: sourceName,
    description: j.description.slice(0, 500),
    apply_url: j.url,
    job_fingerprint: fingerprint,
  };
}

// Discovery queries — ATS platforms + top Indian job boards (LinkedIn, Naukri, Instahyre, Wellfound, etc.)
const DISCOVERY_QUERIES = [
  // Official ATS platforms
  `site:lever.co "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:greenhouse.io "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:myworkdayjobs.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:ashbyhq.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:smartrecruiters.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:bamboohr.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:taleo.net "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:icims.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:successfactors.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  // Third-party job boards — India-focused
  `site:linkedin.com/jobs "India" (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist)`,
  `site:naukri.com (developer OR engineer OR designer OR manager OR analyst OR intern OR specialist) "Bengaluru" OR "Hyderabad" OR "Pune" OR "Mumbai" OR "Remote"`,
  `site:wellfound.com/jobs "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `site:instahyre.com "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `site:cutshort.io/jobs "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `site:hirist.tech "India" (developer OR engineer OR designer OR manager OR analyst)`,
  `site:internshala.com "India" (developer OR engineer OR designer OR manager OR intern)`,
  `site:indeed.co.in (developer OR engineer OR designer OR manager OR analyst OR intern) "Bengaluru" OR "Hyderabad" OR "Pune" OR "Mumbai"`,
  `site:glassdoor.co.in "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `site:foundit.in (developer OR engineer OR designer OR manager OR analyst OR intern) "Bengaluru" OR "Hyderabad" OR "Pune" OR "Mumbai"`,
  // Company careers pages — catch-all
  `"careers" site:*.io "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `"jobs" site:*.com/careers "India" (developer OR engineer OR analyst OR manager OR specialist)`,
];

export async function runJobScraper() {
  if (isCurrentlyScraping) {
    const state = loadJobState();
    logJobMessage(state, '⚠️ Scan request ignored: Discovery engine is already active.');
    return state;
  }

  const jobsState = loadJobState();
  isCurrentlyScraping = true;
  jobsState.status = 'running';

  await initDatabase().catch(err => console.error('Database connection failed:', err));

  logJobMessage(jobsState, '🚀 Live India Job Discovery Agent session started.');
  saveJobState(jobsState);

  try {
    const rawDiscoveredJobs: Omit<ScrapedJob, 'status' | 'first_seen_timestamp' | 'last_seen_timestamp'>[] = [];
    const seenUrls = new Set<string>();

    logJobMessage(jobsState, `🔍 Querying live search index across ${DISCOVERY_QUERIES.length} sources...`);
    saveJobState(jobsState);


    // ── Shared helper to ingest any JobItem[] into rawDiscoveredJobs ──────────
    function ingestItems(items: JobItem[], defaultSource: string) {
      let added = 0;
      for (const j of items) {
        if (!j.url || !j.title) continue;
        const urlKey = j.url.split('?')[0].toLowerCase();
        if (seenUrls.has(urlKey)) continue;
        seenUrls.add(urlKey);
        const srcName = j.sourceName || defaultSource;
        const isJobBoard = ['LinkedIn','Naukri','Indeed','Glassdoor','Wellfound',
          'Instahyre','CutShort','Hirist','Internshala','Foundit','Monster',
          'Shine','AmbitionBox','TimesJobs','FreshersWorld','Remotive'].includes(srcName);
        (rawDiscoveredJobs as any[]).push(buildJobFromAtsItem(j, srcName, isJobBoard));
        added++;
      }
      return added;
    }

    // ── Phase 1-A: Greenhouse direct JSON API ─────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-A: Greenhouse API...');
    saveJobState(jobsState);
    let p1Total = 0;
    for (const slug of GREENHOUSE_COMPANIES) {
      const jobs = await fetchGreenhouseJobs(slug);
      const n = ingestItems(jobs, 'Greenhouse');
      if (n > 0) logJobMessage(jobsState, `  ✅ Greenhouse/${slug}: ${n} India jobs`);
      p1Total += n;
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-B: Lever direct JSON API ─────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-B: Lever API...');
    saveJobState(jobsState);
    for (const slug of LEVER_COMPANIES) {
      const jobs = await fetchLeverJobs(slug);
      const n = ingestItems(jobs, 'Lever');
      if (n > 0) logJobMessage(jobsState, `  ✅ Lever/${slug}: ${n} India jobs`);
      p1Total += n;
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-C: Ashby direct API ───────────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-C: Ashby API...');
    saveJobState(jobsState);
    for (const slug of ASHBY_COMPANIES) {
      const jobs = await fetchAshbyJobs(slug);
      const n = ingestItems(jobs, 'Ashby');
      if (n > 0) logJobMessage(jobsState, `  ✅ Ashby/${slug}: ${n} India jobs`);
      p1Total += n;
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-D: SmartRecruiters API ───────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-D: SmartRecruiters API...');
    saveJobState(jobsState);
    for (const slug of SMARTRECRUITERS_COMPANIES) {
      const jobs = await fetchSmartRecruitersJobs(slug);
      const n = ingestItems(jobs, 'SmartRecruiters');
      if (n > 0) logJobMessage(jobsState, `  ✅ SmartRecruiters/${slug}: ${n} India jobs`);
      p1Total += n;
      await new Promise(r => setTimeout(r, 200));
    }

    logJobMessage(jobsState, `📊 Phase 1 (ATS APIs) complete: ${p1Total} unique jobs found.`);
    saveJobState(jobsState);

    // ── Phase 2-A: Indeed India RSS (role × city matrix) ─────────────────────
    logJobMessage(jobsState, '📰 Phase 2-A: Indeed India RSS feeds...');
    saveJobState(jobsState);
    let p2Total = 0;
    for (const role of INDIA_ROLE_QUERIES.slice(0, 12)) { // top 12 roles
      const [all, ...cityResults] = await Promise.allSettled([
        fetchIndeedRSS(role, 'India'),
        ...INDIA_CITIES.slice(0, 4).map(city => fetchIndeedRSS(role, city))
      ]);
      const allJobs = [
        ...(all.status === 'fulfilled' ? all.value : []),
        ...cityResults.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      ];
      const n = ingestItems(allJobs, 'Indeed');
      if (n > 0) logJobMessage(jobsState, `  📰 Indeed "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Phase 2-B: Naukri RSS (role × city) ──────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-B: Naukri RSS feeds...');
    saveJobState(jobsState);
    for (const role of INDIA_ROLE_QUERIES.slice(0, 10)) {
      const results = await Promise.allSettled([
        fetchNaukriRSS(role, ''),
        ...INDIA_CITIES.slice(0, 3).map(city => fetchNaukriRSS(role, city))
      ]);
      const allJobs = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      const n = ingestItems(allJobs, 'Naukri');
      if (n > 0) logJobMessage(jobsState, `  📰 Naukri "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Phase 2-C: TimesJobs RSS ──────────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-C: TimesJobs RSS...');
    saveJobState(jobsState);
    for (const role of INDIA_ROLE_QUERIES.slice(0, 8)) {
      const jobs = await fetchTimesJobsRSS(role);
      const n = ingestItems(jobs, 'TimesJobs');
      if (n > 0) logJobMessage(jobsState, `  📰 TimesJobs "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 250));
    }

    // ── Phase 2-D: Shine RSS ──────────────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-D: Shine RSS...');
    saveJobState(jobsState);
    for (const role of INDIA_ROLE_QUERIES.slice(0, 8)) {
      const jobs = await fetchShineRSS(role);
      const n = ingestItems(jobs, 'Shine');
      if (n > 0) logJobMessage(jobsState, `  📰 Shine "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 250));
    }

    // ── Phase 2-E: Freshersworld RSS (entry-level) ────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-E: FreshersWorld RSS...');
    saveJobState(jobsState);
    for (const role of ['software engineer', 'frontend developer', 'backend developer', 'data analyst', 'product manager', 'intern developer']) {
      const jobs = await fetchFreshersworldRSS(role);
      const n = ingestItems(jobs, 'FreshersWorld');
      if (n > 0) logJobMessage(jobsState, `  📰 FreshersWorld "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 250));
    }

    // ── Phase 2-F: Remotive (remote India roles) ──────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-F: Remotive (remote India)...');
    saveJobState(jobsState);
    for (const role of ['software engineer', 'fullstack developer', 'devops engineer', 'data scientist', 'product manager']) {
      const jobs = await fetchRemotiveJobs(role);
      const n = ingestItems(jobs, 'Remotive');
      if (n > 0) logJobMessage(jobsState, `  📰 Remotive "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 200));
    }

    logJobMessage(jobsState, `📊 Phase 2 (RSS + Public APIs) complete: ${p2Total} unique jobs found.`);
    logJobMessage(jobsState, `🎯 Total unique jobs from all sources: ${rawDiscoveredJobs.length}`);
    saveJobState(jobsState);

    // --- Phase 2: Search engine sweep (best-effort, timeouts are normal) ---
    for (let i = 0; i < DISCOVERY_QUERIES.length; i++) {
      const q = DISCOVERY_QUERIES[i];
      try {
        logJobMessage(jobsState, `🔄 Search sweep [${i+1}/${DISCOVERY_QUERIES.length}]...`);
        saveJobState(jobsState);

        let searchResults: { url: string; title: string; description: string }[] = [];
        try {
          searchResults = await Promise.any([
            queryDDGJobs(q),
            queryYahooJobs(q)
          ]);
        } catch {
          logJobMessage(jobsState, `  ⏭️ Search [${i+1}] timed out — skipping (ATS data still captured).`);
          saveJobState(jobsState);
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        searchResults.forEach(res => {
          const urlStr = res.url.split('?')[0];
          if (seenUrls.has(urlStr.toLowerCase())) return;
          
          if (!isValidJobPage(res.url, res.title)) {
            return;
          }
          
          seenUrls.add(urlStr.toLowerCase());

          const { company, title } = parseCompanyAndTitle(res.url, res.title);

          let sourceName = 'Company Careers';
          if (res.url.includes('lever.co')) { sourceName = 'Lever'; }
          else if (res.url.includes('greenhouse.io')) { sourceName = 'Greenhouse'; }
          else if (res.url.includes('myworkdayjobs.com')) { sourceName = 'Workday'; }
          else if (res.url.includes('ashbyhq.com')) { sourceName = 'Ashby'; }
          else if (res.url.includes('smartrecruiters.com')) { sourceName = 'SmartRecruiters'; }
          else if (res.url.includes('bamboohr.com')) { sourceName = 'BambooHR'; }
          else if (res.url.includes('taleo.net') || res.url.includes('oraclecloud.com')) { sourceName = 'Taleo'; }
          else if (res.url.includes('icims.com')) { sourceName = 'iCIMS'; }
          else if (res.url.includes('successfactors.com') || res.url.includes('successfactors.eu')) { sourceName = 'SuccessFactors'; }
          // Third-party job boards
          else if (res.url.includes('linkedin.com')) { sourceName = 'LinkedIn'; }
          else if (res.url.includes('naukri.com')) { sourceName = 'Naukri'; }
          else if (res.url.includes('indeed.co.in') || res.url.includes('indeed.com')) { sourceName = 'Indeed'; }
          else if (res.url.includes('glassdoor.co.in') || res.url.includes('glassdoor.com')) { sourceName = 'Glassdoor'; }
          else if (res.url.includes('wellfound.com')) { sourceName = 'Wellfound'; }
          else if (res.url.includes('instahyre.com')) { sourceName = 'Instahyre'; }
          else if (res.url.includes('cutshort.io')) { sourceName = 'CutShort'; }
          else if (res.url.includes('hirist.tech') || res.url.includes('hirist.com')) { sourceName = 'Hirist'; }
          else if (res.url.includes('internshala.com')) { sourceName = 'Internshala'; }
          else if (res.url.includes('foundit.in')) { sourceName = 'Foundit'; }
          else if (res.url.includes('monsterindia.com') || res.url.includes('monster.com')) { sourceName = 'Monster'; }
          else if (res.url.includes('shine.com')) { sourceName = 'Shine'; }
          else if (res.url.includes('ambitionbox.com')) { sourceName = 'AmbitionBox'; }

          let careerPageUrl = '';
          try {
            const parsed = new URL(res.url);
            if (sourceName === 'Lever') {
              const parts = parsed.pathname.split('/').filter(Boolean);
              if (parts.length > 0) {
                careerPageUrl = `https://jobs.lever.co/${parts[0]}`;
              }
            } else if (sourceName === 'Greenhouse') {
              const parts = parsed.pathname.split('/').filter(Boolean);
              if (parts.length > 0 && parts[0] !== 'embed') {
                careerPageUrl = `https://boards.greenhouse.io/${parts[0]}`;
              } else {
                const forCompany = parsed.searchParams.get('for');
                if (forCompany) {
                  careerPageUrl = `https://boards.greenhouse.io/${forCompany}`;
                }
              }
            } else if (sourceName === 'Workday') {
              careerPageUrl = `https://${parsed.hostname}/Careers`;
            } else {
              careerPageUrl = `${parsed.protocol}//${parsed.hostname}${parsed.pathname.split('/').slice(0, 2).join('/')}`;
            }
          } catch (e) {
            careerPageUrl = res.url;
          }

          let companyWebsite = '';
          const isAts = ['Lever', 'Greenhouse', 'Workday', 'Ashby', 'SmartRecruiters', 'BambooHR', 'Taleo', 'iCIMS', 'SuccessFactors'].includes(sourceName);
          const isJobBoard = ['LinkedIn', 'Naukri', 'Indeed', 'Glassdoor', 'Wellfound', 'Instahyre', 'CutShort', 'Hirist', 'Internshala', 'Foundit', 'Monster', 'Shine', 'AmbitionBox'].includes(sourceName);
          if (!isAts && !isJobBoard) {
            try {
              const parsed = new URL(res.url);
              companyWebsite = `${parsed.protocol}//${parsed.hostname}`;
            } catch (e) {}
          }

          const workMode = extractWorkMode(title, res.description);
          const cityState = parseCityAndState(title, res.description, res.url, 'India');

          // Initialize fields matching strict 24-field schema and UI compat fields
          const partialJob: Omit<ScrapedJob, 'job_id' | 'job_fingerprint' | 'status' | 'first_seen_timestamp' | 'last_seen_timestamp'> = {
            job_title: title,
            company_name: company,
            company_website: companyWebsite,
            career_page_url: careerPageUrl,
            job_url: res.url,
            location: cityState.city ? `${cityState.city}, ${cityState.state}, India` : 'India',
            city: cityState.city,
            state: cityState.state,
            country: 'India',
            employment_type: extractEmploymentType(title, res.description),
            work_mode: workMode,
            experience_required: extractExperience(title, res.description),
            skills: extractSkills(title, res.description),
            department: '',
            posted_date: new Date().toISOString(),
            application_deadline: '',
            source_type: isJobBoard ? 'THIRD_PARTY' : 'OFFICIAL',
            source_name: sourceName,
            description: cleanHtmlText(res.description),
            apply_url: res.url,

            // Compatibility keys
            id: '',
            title: title,
            companyName: company,
            url: res.url,
            scrapedAt: new Date().toISOString(),
            postedDate: new Date().toISOString(),
            remote: workMode === 'remote',
            salary: '',
            salary_range: ''
          };

          const fingerprint = generateJobFingerprint(partialJob);

          rawDiscoveredJobs.push({
            ...partialJob,
            job_id: fingerprint,
            job_fingerprint: fingerprint,
            
            // Compatibility mapping
            id: fingerprint,
            title,
            companyName: company,
            url: res.url,
            postedDate: new Date().toISOString(),
            scrapedAt: new Date().toISOString()
          });
        });
      } catch (err: any) {
        let errMsg = err.message;
        if (err.errors && Array.isArray(err.errors)) {
          errMsg = err.errors.map((e: any) => e.message || String(e)).join(' | ');
        }
        logJobMessage(jobsState, `⚠️ Crawl sweep error: ${errMsg}`);
        saveJobState(jobsState);
      }
      
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    logJobMessage(jobsState, `✅ Crawl completed. Processing ${rawDiscoveredJobs.length} opportunities...`);
    saveJobState(jobsState);

    // Layer 1 raw scrape log
    saveRawScrapeLog(rawDiscoveredJobs as ScrapedJob[]);

    // Deduplication rules
    const uniqueCandidateJobs: ScrapedJob[] = [];
    const seenJobGroups = new Set<string>();
    const seenFingerprints = new Set<string>();
    const seenUrlsSet = new Set<string>();
    let duplicateJobsSkipped = 0;
    let dupCounter = 0;

    for (const job of rawDiscoveredJobs) {
      const cleanUrl = job.job_url.split('?')[0].toLowerCase();
      const cleanApplyUrl = job.apply_url ? job.apply_url.split('?')[0].toLowerCase() : '';
      
      let isDuplicate = false;

      // Duplication checks
      if (seenUrlsSet.has(cleanUrl) || (cleanApplyUrl && seenUrlsSet.has(cleanApplyUrl)) || seenFingerprints.has(job.job_id)) {
        isDuplicate = true;
      }

      const normTitle = job.job_title.toLowerCase().replace(/\s+/g, '');
      const normCompany = normalizeCompanyName(job.company_name).toLowerCase();
      const normLoc = job.location.toLowerCase().replace(/\s+/g, '');
      const groupKey = `${normCompany}|${normTitle}|${normLoc}`;

      if (seenJobGroups.has(groupKey)) {
        isDuplicate = true;
      }

      // Exclude agency posts if direct company post exists
      if (isStaffingAgency(job.company_name)) {
        const directExists = rawDiscoveredJobs.some(rj => 
          rj.job_title.toLowerCase().replace(/\s+/g, '') === normTitle && 
          normalizeCompanyName(rj.company_name).toLowerCase() === normCompany &&
          !isStaffingAgency(rj.company_name)
        );
        if (directExists) {
          isDuplicate = true;
        }
      }

      seenUrlsSet.add(cleanUrl);
      if (cleanApplyUrl) seenUrlsSet.add(cleanApplyUrl);

      if (isDuplicate || seenFingerprints.has(job.job_id)) {
        duplicateJobsSkipped++;
        continue;
      }
      seenFingerprints.add(job.job_id);
      seenJobGroups.add(groupKey);
      
      uniqueCandidateJobs.push({
        ...job,
        status: 'OPEN',
        is_duplicate: false,
        isDuplicate: false,
        first_seen_timestamp: new Date().toISOString(),
        last_seen_timestamp: new Date().toISOString(),
        scrapedAt: new Date().toISOString()
      });
    }

    // Comparison Engine (OPEN vs CLOSED vs UPDATED)
    const previousJobsMap = new Map<string, ScrapedJob>();
    const previousJobsList = isPgAvailable ? await dbLoadJobs() : jobsState.jobs;
    previousJobsList.forEach(j => previousJobsMap.set(j.job_id, j));

    const discoveredJobIds = new Set<string>();
    let newJobsFound = 0;
    let updatedJobsFound = 0;

    const nextJobsStateList: ScrapedJob[] = [];

    // 1. Process discovered jobs
    for (const job of uniqueCandidateJobs) {
      discoveredJobIds.add(job.job_id);

      const exists = previousJobsMap.get(job.job_id);
      if (!exists) {
        nextJobsStateList.push(job);
        newJobsFound++;
        dbUpsertJob(job).catch(err => console.error(err));
      } else {
        const isFieldUpdated = 
          exists.location !== job.location || 
          exists.work_mode !== job.work_mode || 
          exists.status !== 'OPEN';

        if (isFieldUpdated) {
          updatedJobsFound++;
        }

        const updatedJob: ScrapedJob = {
          ...exists,
          ...job,
          first_seen_timestamp: exists.first_seen_timestamp,
          last_seen_timestamp: new Date().toISOString(),
          status: 'OPEN'
        };
        nextJobsStateList.push(updatedJob);
        dbUpsertJob(updatedJob).catch(err => console.error(err));
      }
    }

    // 2. Process closed jobs
    let closedJobsFound = 0;
    for (const prevJob of previousJobsList) {
      if (!discoveredJobIds.has(prevJob.job_id) && prevJob.status === 'OPEN') {
        const isSeededJob = prevJob.is_seeded || prevJob.isSeeded;
        const isActive = isSeededJob ? true : await validateUrlActive(prevJob.job_url);
        
        if (!isActive) {
          logJobMessage(jobsState, `🔗 Link validation failed, closing: "${prevJob.job_title}"...`);
          prevJob.status = 'CLOSED';
          prevJob.last_seen_timestamp = new Date().toISOString();
          closedJobsFound++;
          dbUpsertJob(prevJob).catch(err => console.error(err));
        } else if (!isSeededJob) {
          logJobMessage(jobsState, `🔗 Link validation passed: "${prevJob.job_title}"`);
        }
        nextJobsStateList.push(prevJob);
      } else if (prevJob.status === 'CLOSED') {
        nextJobsStateList.push(prevJob);
      }
    }

    jobsState.jobs = nextJobsStateList;

    if (jobsState.jobs.length > 50000) {
      jobsState.jobs = jobsState.jobs.slice(0, 50000);
    }

    jobsState.status = 'idle';
    jobsState.lastRunTime = new Date().toISOString();
    logJobMessage(jobsState, `🎉 Sweep completed. Discovered ${newJobsFound} new jobs, closed ${closedJobsFound} jobs.`);
    saveJobState(jobsState);

    // Export to CSV
    exportToCSV(jobsState.jobs);

    // Strict 6-field Hourly Summary report
    const report: HourlyReport = {
      scan_time: new Date().toISOString(),
      new_jobs_found: newJobsFound,
      updated_jobs_found: updatedJobsFound,
      closed_jobs_found: closedJobsFound,
      duplicate_jobs_skipped: duplicateJobsSkipped,
      companies_scanned: new Set(rawDiscoveredJobs.map(j => j.company_name)).size
    };

    saveLocalHourlyReport(report);
    dbSaveHourlyReport(report).catch(err => console.error(err));

  } catch (err: any) {
    jobsState.status = 'idle';
    logJobMessage(jobsState, `❌ Discovery run aborted: ${err.message}`);
    saveJobState(jobsState);
  } finally {
    isCurrentlyScraping = false;
  }

  return jobsState;
}

export async function clearScrapedJobs(): Promise<JobScrapeState> {
  const state = loadJobState();
  state.jobs = [];
  state.status = 'idle';
  state.logs = ['🗑️ Jobs Discovery Agent database cleared.'];
  saveJobState(state);
  exportToCSV([]);
  if (isPgAvailable) {
    await dbClearJobs().catch(err => console.error(err));
  }
  return state;
}

const SKILLS_DICT = [
  'React', 'Angular', 'Vue', 'Next.js', 'Svelte', 'Tailwind', 'HTML', 'CSS',
  'Node.js', 'Express', 'Django', 'FastAPI', 'Spring Boot', 'Ruby on Rails',
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'Go', 'Rust', 'Kotlin', 'Swift', 'PHP', 'C#',
  'AWS', 'Docker', 'Kubernetes', 'GCP', 'Azure', 'Terraform', 'Ansible', 'CI/CD', 'DevOps', 'Cloud',
  'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch',
  'PyTorch', 'TensorFlow', 'Machine Learning', 'ML', 'AI', 'NLP', 'LLM', 'Data Science', 'Data Analytics',
  'SDET', 'QA', 'Cypress', 'Playwright', 'Selenium', 'Jest', 'Testing',
  'Product Management', 'Agile', 'Scrum', 'Figma', 'UI/UX', 'Design',
  'Cybersecurity', 'Security', 'Android', 'iOS', 'Flutter', 'React Native'
];
