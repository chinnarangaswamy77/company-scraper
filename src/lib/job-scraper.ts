import fs from 'fs';
import path from 'path';
import {
  dbUpsertJob,
  dbUpsertAiJob,
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
import { isAiEnabled } from './ai/model-registry';
import { aiExtractJob } from './ai/job-extractor';

export interface JobScrapeState {
  status: 'idle' | 'running' | 'completed';
  lastRunTime: string | null;
  nextRunTime: string | null;
  jobs: ScrapedJob[];
  logs: string[];
  intervalMins?: number;
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
    logs: ['Jobs Discovery Agent database initialized.'],
    intervalMins: 10
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

export function startJobScraperCron(intervalMins?: number) {
  const state = loadJobState();
  const finalInterval = intervalMins || state.intervalMins || 10;

  if (state.intervalMins !== finalInterval) {
    state.intervalMins = finalInterval;
    saveJobState(state);
  }

  if (globalWithCron.currentIntervalMinutes === finalInterval && globalWithCron.backgroundCronInterval) {
    return;
  }

  if (globalWithCron.backgroundCronInterval) {
    clearInterval(globalWithCron.backgroundCronInterval);
  }

  const scheduleNextRun = () => {
    state.nextRunTime = new Date(Date.now() + finalInterval * 60 * 1000).toISOString();
    saveJobState(state);
  };

  if (!state.nextRunTime || globalWithCron.currentIntervalMinutes !== finalInterval) {
    scheduleNextRun();
  }

  logJobMessage(state, `⏰ ${finalInterval}-Minute background Job Discovery Agent started.`);
  saveJobState(state);

  globalWithCron.backgroundCronInterval = setInterval(async () => {
    const currentState = loadJobState();
    currentState.lastRunTime = new Date().toISOString();
    currentState.nextRunTime = new Date(Date.now() + finalInterval * 60 * 1000).toISOString();
    saveJobState(currentState);

    try {
      await runJobScraper();
    } catch (err: any) {
      console.error(`${finalInterval}-minute job discovery run failed:`, err.message);
    }
  }, finalInterval * 60 * 1000);

  globalWithCron.currentIntervalMinutes = finalInterval;
}

export function stopJobScraperCron() {
  const state = loadJobState();
  const currentInt = globalWithCron.currentIntervalMinutes || state.intervalMins || 10;
  if (globalWithCron.backgroundCronInterval) {
    clearInterval(globalWithCron.backgroundCronInterval);
    globalWithCron.backgroundCronInterval = undefined;
  }
  globalWithCron.currentIntervalMinutes = undefined;
  logJobMessage(state, `🛑 ${currentInt}-Minute background Job Discovery Agent stopped.`);
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
  } catch (e) { }

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
    // Strip leading count-prefixes like "50+ ", "21+ ", "100+ "
    .replace(/^\d+\+?\s+/g, '')
    // Strip trailing "Jobs in <location>", "Jobs in", "Jobs" noise from listing pages
    .replace(/\s+[Jj]obs\s+in\b.*/g, '')
    .replace(/\s+[Jj]obs\b\s*$/g, '')
    // Strip location words
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
        } catch (e) { }
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
        } catch (e) { }
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

async function fetchSearchWithRetry(url: string, init: RequestInit, maxAttempts = 2): Promise<Response> {
  let attempts = 0;
  let delay = 1500;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      // Rotate user agent on retry if headers exist
      if (attempts > 1 && init.headers) {
        const headers = init.headers as Record<string, string>;
        headers['User-Agent'] = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      }
      const response = await fetch(url, init);
      // Retry on rate limit (429) or temporary server errors (5xx)
      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        if (attempts === maxAttempts) {
          return response;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      return response;
    } catch (e) {
      if (attempts === maxAttempts) {
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Search request failed after maximum retry attempts');
}

async function queryDDGJobs(query: string): Promise<{ url: string; title: string; description: string }[]> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://html.duckduckgo.com/html/`;

  const response = await fetchSearchWithRetry(url, {
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

  const response = await fetchSearchWithRetry(url, {
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

async function queryBingJobs(query: string): Promise<{ url: string; title: string; description: string }[]> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

  const response = await fetchSearchWithRetry(url, {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.bing.com/'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`Bing status ${response.status}`);
  const html = await response.text();
  return extractUrlsFromBingHtml(html);
}

function extractUrlsFromBingHtml(html: string): { url: string; title: string; description: string }[] {
  const results: { url: string; title: string; description: string }[] = [];
  const regex = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    let url = match[1];
    const title = match[2];

    // Decode Bing redirect URL if present
    if (url.includes('/ck/a?!') && url.includes('&u=')) {
      const uMatch = /[&?]u=([^&"'>]+)/.exec(url);
      if (uMatch) {
        try {
          let encoded = uMatch[1];
          if (encoded.startsWith('a1')) {
            encoded = encoded.substring(2);
          }
          const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(base64, 'base64').toString('utf-8');
          if (decoded.startsWith('http')) {
            url = decoded;
          }
        } catch (e) {
          // Fallback to original url
        }
      }
    }

    let description = '';
    const index = html.indexOf(match[0]);
    if (index !== -1) {
      const remaining = html.substring(index, index + 2000);
      const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(remaining);
      if (snippetMatch) {
        description = cleanHtmlText(snippetMatch[1]);
      }
    }

    const cleanUrl = url.replace(/&amp;/g, '&');

    if (cleanUrl.startsWith('http') && !cleanUrl.includes('bing.com')) {
      results.push({
        url: cleanUrl,
        title: cleanHtmlText(title),
        description
      });
    }
  }
  return results;
}

async function queryBraveJobs(query: string): Promise<{ url: string; title: string; description: string }[]> {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;

  const response = await fetchSearchWithRetry(url, {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://search.brave.com/'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`Brave Search status ${response.status}`);
  const html = await response.text();
  return extractUrlsFromBraveHtml(html);
}

function extractUrlsFromBraveHtml(html: string): { url: string; title: string; description: string }[] {
  const results: { url: string; title: string; description: string }[] = [];
  const regex = /class="snippet[^"]*"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>[\s\S]*?class="title[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2];
    const description = match[3];

    const cleanUrl = url.replace(/&amp;/g, '&');

    if (cleanUrl.startsWith('http') && !cleanUrl.includes('brave.com')) {
      results.push({
        url: cleanUrl,
        title: cleanHtmlText(title),
        description: cleanHtmlText(description)
      });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
//  DIRECT ATS & JOB-BOARD API FETCHERS
// ─────────────────────────────────────────────────────────────

type JobItem = { url: string; title: string; description: string; location: string; sourceName?: string; companyName?: string };

function isIndiaLocation(loc: string): boolean {
  if (!loc) return true; // include if unknown
  const l = loc.toLowerCase().trim();
  if (l === '') return true;

  // List of clear foreign country/city indicators to exclude
  const foreignIndicators = [
    'united states', 'usa', 'united kingdom', 'uk', 'london', 'great britain',
    'canada', 'toronto', 'vancouver', 'germany', 'berlin', 'munich',
    'france', 'paris', 'australia', 'sydney', 'melbourne', 'singapore',
    'japan', 'tokyo', 'china', 'beijing', 'shanghai', 'hong kong',
    'netherlands', 'amsterdam', 'switzerland', 'zurich', 'geneva',
    'poland', 'warsaw', 'ukraine', 'kyiv', 'brazil', 'sao paulo',
    'mexico', 'spain', 'madrid', 'barcelona', 'italy', 'rome', 'milan',
    'ireland', 'dublin', 'sweden', 'stockholm', 'norway', 'oslo',
    'denmark', 'copenhagen', 'finland', 'helsinki', 'belgium', 'brussels',
    'austria', 'vienna', 'uae', 'dubai', 'abu dhabi', 'saudi arabia', 'riyadh',
    'new zealand', 'auckland', 'south africa', 'johannesburg', 'cape town',
    'vietnam', 'hanoi', 'ho chi minh', 'philippines', 'manila',
    'indonesia', 'jakarta', 'malaysia', 'kuala lumpur', 'thailand', 'bangkok',
    'san francisco', 'new york', 'seattle', 'boston', 'austin', 'chicago',
    'los angeles', 'california', 'texas', 'washington', 'massachusetts',
    'illinois', 'colorado', 'denver', 'portland', 'oregon'
  ];

  for (const indicator of foreignIndicators) {
    const regex = new RegExp(`\\b${indicator}\\b`, 'i');
    if (regex.test(l)) {
      return false;
    }
  }

  // Check if it has Indian indicators
  const indianIndicators = [
    'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai',
    'chennai', 'noida', 'gurugram', 'gurgaon', 'kochi', 'cochin', 'delhi',
    'kolkata', 'trivandrum', 'thiruvananthapuram', 'karnataka', 'telangana',
    'maharashtra', 'tamil nadu', 'uttar pradesh', 'haryana', 'kerala',
    'west bengal', 'ahmedabad', 'gujarat', 'jaipur', 'rajasthan', 'indore',
    'madhya pradesh', 'chandigarh', 'bhubaneswar', 'odisha', 'coimbatore'
  ];

  for (const ind of indianIndicators) {
    if (l.includes(ind)) return true;
  }

  // Check if remote or hybrid (without other foreign exclusions)
  if (l.includes('remote') || l.includes('wfh') || l.includes('hybrid') || l.includes('anywhere')) {
    const globalExclusions = [
      'us only', 'usa only', 'americas', 'europe', 'emea', 'latam',
      'north america', 'canada only', 'uk only', 'germany only'
    ];
    for (const excl of globalExclusions) {
      if (l.includes(excl)) return false;
    }
    return true; // standard remote
  }

  return false;
}

function isIndiaSearchResult(title: string, snippet: string, url: string): boolean {
  const t = title.toLowerCase();
  const s = snippet.toLowerCase();
  const u = url.toLowerCase();

  // If the url contains a foreign country code subpath, reject it.
  if (/\/(us|uk|ca|sg|ae|au|gb|nz|de|fr|hk)\//.test(u)) {
    if (!u.includes('/in/') && !u.includes('/india/') && !t.includes('india')) {
      return false;
    }
  }

  // Check for foreign cities/countries in the title or search url domain suffix
  const foreignTitleIndicators = [
    'united states', 'usa', 'united kingdom', 'london',
    'canada', 'toronto', 'vancouver', 'germany', 'berlin', 'munich',
    'australia', 'sydney', 'melbourne', 'singapore', 'tokyo', 'japan',
    'san francisco', 'new york', 'seattle', 'boston', 'austin', 'dubai'
  ];
  for (const indicator of foreignTitleIndicators) {
    if (t.includes(indicator) || u.includes(indicator.replace(/\s+/g, ''))) {
      return false;
    }
  }

  // It must mention at least one Indian city, state, or the word "India"
  const indianKeywords = [
    'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai',
    'chennai', 'noida', 'gurugram', 'gurgaon', 'kochi', 'cochin', 'delhi',
    'kolkata', 'trivandrum', 'karnataka', 'telangana', 'maharashtra',
    'tamil nadu', 'uttar pradesh', 'haryana', 'kerala', 'west bengal'
  ];

  const combined = `${t} ${s} ${u}`;
  return indianKeywords.some(keyword => combined.includes(keyword));
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

async function fetchWWRJobs(): Promise<JobItem[]> {
  try {
    const url = 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => {
        const parts = i.title.split(':');
        const company = parts.length > 1 ? parts[0].trim() : '';
        const title = parts.length > 1 ? parts.slice(1).join(':').trim() : i.title;
        return {
          url: i.link,
          title,
          description: i.description,
          location: 'Remote',
          sourceName: 'WeWorkRemotely',
          companyName: company
        };
      });
  } catch { return []; }
}

async function fetchRemoteOKJobs(): Promise<JobItem[]> {
  try {
    const url = 'https://remoteok.com/remote-jobs.rss';
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => {
        const parts = i.title.split(':');
        const company = parts.length > 1 ? parts[0].trim() : '';
        const title = parts.length > 1 ? parts.slice(1).join(':').trim() : i.title;
        return {
          url: i.link,
          title,
          description: i.description,
          location: 'Remote',
          sourceName: 'RemoteOK',
          companyName: company
        };
      });
  } catch { return []; }
}

async function fetchHimalayasJobs(): Promise<JobItem[]> {
  try {
    const url = 'https://himalayas.app/jobs.rss';
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml)
      .filter(i => i.title && i.link)
      .map(i => {
        const match = /at\s+([^-|]*)/i.exec(i.title);
        const company = match ? match[1].trim() : '';
        const parts = i.title.split(/\s+at\s+/i);
        const title = parts.length > 0 ? parts[0].trim() : i.title;
        return {
          url: i.link,
          title,
          description: i.description,
          location: 'Remote',
          sourceName: 'Himalayas',
          companyName: company
        };
      });
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

  // Skip generic list-page titles (e.g. "50+ Frontend Developer Jobs in India", "21+ Internship Jobs")
  if (/^\d+\+?\s/i.test(title)) return false;
  if (/\b\d+\+\s*(jobs|openings|vacancies|results)\b/i.test(title)) return false;
  if (/(dream job|job vacancies|job openings|all jobs|search results)/i.test(title)) return false;
  // Also filter out titles that still contain "X Jobs in" or "X Jobs" as listing-page noise
  if (/\bjobs\s+in\b/i.test(title) && /^\d/.test(title.trim())) return false;

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
  } catch { }

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
  `"careers" (site:*.io OR site:*.in OR site:*.co OR site:*.co.in OR site:*.net OR site:*.org OR site:*.tech OR site:*.ai) "India" (developer OR engineer OR designer OR manager OR analyst OR intern)`,
  `"jobs" (site:*.com/careers OR site:*.in/careers OR site:*.co/careers OR site:*.co.in/careers OR site:*.net/careers OR site:*.org/careers OR site:*.tech/careers OR site:*.ai/careers) "India" (developer OR engineer OR analyst OR manager OR specialist)`,
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

        // Strict India checks
        const loc = j.location || '';
        if (!isIndiaLocation(loc)) continue;
        
        if (loc === '' || loc.toLowerCase() === 'remote' || loc.toLowerCase() === 'anywhere') {
          if (!isIndiaSearchResult(j.title, j.description || '', j.url)) {
            continue;
          }
        }

        seenUrls.add(urlKey);
        const srcName = j.sourceName || defaultSource;
        const isJobBoard = ['LinkedIn', 'Naukri', 'Indeed', 'Glassdoor', 'Wellfound',
          'Instahyre', 'CutShort', 'Hirist', 'Internshala', 'Foundit', 'Monster',
          'Shine', 'AmbitionBox', 'TimesJobs', 'FreshersWorld', 'Remotive'].includes(srcName);
        (rawDiscoveredJobs as any[]).push(buildJobFromAtsItem(j, srcName, isJobBoard));
        added++;
      }
      return added;
    }

    // ── Phase 1-A: Greenhouse direct JSON API ─────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-A: Greenhouse API (batch-parallel)...');
    saveJobState(jobsState);
    let p1Total = 0;
    const ghBatchSize = 6;
    for (let i = 0; i < GREENHOUSE_COMPANIES.length; i += ghBatchSize) {
      const batch = GREENHOUSE_COMPANIES.slice(i, i + ghBatchSize);
      const results = await Promise.allSettled(batch.map(slug => fetchGreenhouseJobs(slug)));
      results.forEach((r, idx) => {
        const slug = batch[idx];
        if (r.status === 'fulfilled' && r.value.length > 0) {
          const n = ingestItems(r.value, 'Greenhouse');
          if (n > 0) logJobMessage(jobsState, `  ✅ Greenhouse/${slug}: ${n} India jobs`);
          p1Total += n;
        }
      });
      saveJobState(jobsState);
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-B: Lever direct JSON API ─────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-B: Lever API (batch-parallel)...');
    saveJobState(jobsState);
    const leverBatchSize = 6;
    for (let i = 0; i < LEVER_COMPANIES.length; i += leverBatchSize) {
      const batch = LEVER_COMPANIES.slice(i, i + leverBatchSize);
      const results = await Promise.allSettled(batch.map(slug => fetchLeverJobs(slug)));
      results.forEach((r, idx) => {
        const slug = batch[idx];
        if (r.status === 'fulfilled' && r.value.length > 0) {
          const n = ingestItems(r.value, 'Lever');
          if (n > 0) logJobMessage(jobsState, `  ✅ Lever/${slug}: ${n} India jobs`);
          p1Total += n;
        }
      });
      saveJobState(jobsState);
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-C: Ashby direct API ───────────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-C: Ashby API (batch-parallel)...');
    saveJobState(jobsState);
    const ashbyBatchSize = 6;
    for (let i = 0; i < ASHBY_COMPANIES.length; i += ashbyBatchSize) {
      const batch = ASHBY_COMPANIES.slice(i, i + ashbyBatchSize);
      const results = await Promise.allSettled(batch.map(slug => fetchAshbyJobs(slug)));
      results.forEach((r, idx) => {
        const slug = batch[idx];
        if (r.status === 'fulfilled' && r.value.length > 0) {
          const n = ingestItems(r.value, 'Ashby');
          if (n > 0) logJobMessage(jobsState, `  ✅ Ashby/${slug}: ${n} India jobs`);
          p1Total += n;
        }
      });
      saveJobState(jobsState);
      await new Promise(r => setTimeout(r, 150));
    }

    // ── Phase 1-D: SmartRecruiters API ───────────────────────────────────────
    logJobMessage(jobsState, '🏢 Phase 1-D: SmartRecruiters API (batch-parallel)...');
    saveJobState(jobsState);
    const srBatchSize = 6;
    for (let i = 0; i < SMARTRECRUITERS_COMPANIES.length; i += srBatchSize) {
      const batch = SMARTRECRUITERS_COMPANIES.slice(i, i + srBatchSize);
      const results = await Promise.allSettled(batch.map(slug => fetchSmartRecruitersJobs(slug)));
      results.forEach((r, idx) => {
        const slug = batch[idx];
        if (r.status === 'fulfilled' && r.value.length > 0) {
          const n = ingestItems(r.value, 'SmartRecruiters');
          if (n > 0) logJobMessage(jobsState, `  ✅ SmartRecruiters/${slug}: ${n} India jobs`);
          p1Total += n;
        }
      });
      saveJobState(jobsState);
      await new Promise(r => setTimeout(r, 200));
    }

    logJobMessage(jobsState, `📊 Phase 1 (ATS APIs) complete: ${p1Total} unique jobs found.`);
    saveJobState(jobsState);

    // ── Phase 2-A: Indeed India RSS (role × city matrix) ─────────────────────
    logJobMessage(jobsState, '📰 Phase 2-A: Indeed India RSS feeds...');
    saveJobState(jobsState);
    let p2Total = 0;
    for (const role of INDIA_ROLE_QUERIES.slice(0, 24)) { // Top 24 roles (engineering, data, design)
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
    for (const role of INDIA_ROLE_QUERIES.slice(0, 20)) { // Top 20 roles
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
    for (const role of INDIA_ROLE_QUERIES.slice(0, 16)) { // Top 16 roles
      const jobs = await fetchTimesJobsRSS(role);
      const n = ingestItems(jobs, 'TimesJobs');
      if (n > 0) logJobMessage(jobsState, `  📰 TimesJobs "${role}": ${n} jobs`);
      p2Total += n;
      await new Promise(r => setTimeout(r, 250));
    }

    // ── Phase 2-D: Shine RSS ──────────────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-D: Shine RSS...');
    saveJobState(jobsState);
    for (const role of INDIA_ROLE_QUERIES.slice(0, 16)) { // Top 16 roles
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

    // ── Phase 2-G: WeWorkRemotely RSS ──────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-G: WeWorkRemotely RSS...');
    saveJobState(jobsState);
    try {
      const wwrJobs = await fetchWWRJobs();
      const nWwr = ingestItems(wwrJobs, 'WeWorkRemotely');
      if (nWwr > 0) logJobMessage(jobsState, `  📰 WeWorkRemotely: ${nWwr} jobs`);
      p2Total += nWwr;
    } catch (e: any) {
      logJobMessage(jobsState, `  ⚠️ WeWorkRemotely failed: ${e.message}`);
    }

    // ── Phase 2-H: RemoteOK RSS ──────────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-H: RemoteOK RSS...');
    saveJobState(jobsState);
    try {
      const remoteOkJobs = await fetchRemoteOKJobs();
      const nRemoteOk = ingestItems(remoteOkJobs, 'RemoteOK');
      if (nRemoteOk > 0) logJobMessage(jobsState, `  📰 RemoteOK: ${nRemoteOk} jobs`);
      p2Total += nRemoteOk;
    } catch (e: any) {
      logJobMessage(jobsState, `  ⚠️ RemoteOK failed: ${e.message}`);
    }

    // ── Phase 2-I: Himalayas RSS ─────────────────────────────────────────────
    logJobMessage(jobsState, '📰 Phase 2-I: Himalayas RSS...');
    saveJobState(jobsState);
    try {
      const himalayasJobs = await fetchHimalayasJobs();
      const nHimalayas = ingestItems(himalayasJobs, 'Himalayas');
      if (nHimalayas > 0) logJobMessage(jobsState, `  📰 Himalayas: ${nHimalayas} jobs`);
      p2Total += nHimalayas;
    } catch (e: any) {
      logJobMessage(jobsState, `  ⚠️ Himalayas failed: ${e.message}`);
    }

    logJobMessage(jobsState, `📊 Phase 2 (RSS + Public APIs) complete: ${p2Total} unique jobs found.`);
    logJobMessage(jobsState, `🎯 Total unique jobs from all sources: ${rawDiscoveredJobs.length}`);
    saveJobState(jobsState);

    // --- Phase 2: Search engine sweep (best-effort, timeouts are normal) ---
    const searchTally = {
      DuckDuckGo: { ok: 0, err: 0 },
      Yahoo: { ok: 0, err: 0 },
      Bing: { ok: 0, err: 0 },
      Brave: { ok: 0, err: 0 }
    };

    for (let i = 0; i < DISCOVERY_QUERIES.length; i++) {
      const q = DISCOVERY_QUERIES[i];
      try {
        logJobMessage(jobsState, `🔄 Search sweep [${i + 1}/${DISCOVERY_QUERIES.length}]...`);
        saveJobState(jobsState);

        let searchResults: { url: string; title: string; description: string }[] = [];
        try {
          const settled = await Promise.allSettled([
            queryDDGJobs(q),
            queryYahooJobs(q),
            queryBingJobs(q),
            queryBraveJobs(q)
          ]);
          
          settled.forEach((r, idx) => {
            const engineNames = ['DuckDuckGo', 'Yahoo', 'Bing', 'Brave'] as const;
            const name = engineNames[idx];
            if (r.status === 'fulfilled') {
              searchTally[name].ok++;
              if (r.value.length > 0) {
                searchResults.push(...r.value);
              }
            } else {
              searchTally[name].err++;
              console.debug(`Search engine ${name} failed:`, r.reason?.message || r.reason);
            }
          });
          
          if (searchResults.length === 0) {
            throw new Error('No results from any search engine');
          }
        } catch {
          logJobMessage(jobsState, `  ⏭️ Search [${i + 1}] returned no results — skipping.`);
          saveJobState(jobsState);
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        searchResults.forEach(res => {
          const urlStr = res.url.split('?')[0];
          if (seenUrls.has(urlStr.toLowerCase())) return;

          const { company, title } = parseCompanyAndTitle(res.url, res.title);

          if (!isValidJobPage(res.url, title)) {
            return;
          }

          // Strict India check for search engine result listings
          if (!isIndiaSearchResult(res.title, res.description, res.url)) {
            return;
          }

          seenUrls.add(urlStr.toLowerCase());

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
            } catch (e) { }
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

    logJobMessage(jobsState, `📊 Search Engines Tally: DuckDuckGo (ok: ${searchTally.DuckDuckGo.ok}, err: ${searchTally.DuckDuckGo.err}), Yahoo (ok: ${searchTally.Yahoo.ok}, err: ${searchTally.Yahoo.err}), Bing (ok: ${searchTally.Bing.ok}, err: ${searchTally.Bing.err}), Brave (ok: ${searchTally.Brave.ok}, err: ${searchTally.Brave.err})`);
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

    // ─── Phase 3: AI Enrichment (only if OPENROUTER_API_KEY is set) ───
    if (isAiEnabled()) {
      logJobMessage(jobsState, '✨ Phase 3: AI Enrichment starting for newly discovered search results...');
      saveJobState(jobsState);

      const atsSources = ['Greenhouse', 'Lever', 'Ashby', 'SmartRecruiters'];
      const toEnrich = uniqueCandidateJobs.filter(j => !atsSources.includes(j.source_name || ''));

      logJobMessage(jobsState, `🧠 Queueing ${toEnrich.length} jobs for AI enrichment...`);
      saveJobState(jobsState);

      const batchSize = 5;
      for (let i = 0; i < toEnrich.length; i += batchSize) {
        const batch = toEnrich.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(async (job) => {
            try {
              const res = await aiExtractJob(job.job_url);
              if (res.success && res.scrapedJobFields) {
                const idx = uniqueCandidateJobs.findIndex(cj => cj.job_id === job.job_id);
                if (idx !== -1) {
                  uniqueCandidateJobs[idx] = {
                    ...uniqueCandidateJobs[idx],
                    ...res.scrapedJobFields,
                    ai_extracted: true
                  } as ScrapedJob;
                  logJobMessage(jobsState, `✨ AI Enriched: "${job.job_title}" at ${job.company_name} (conf: ${res.confidence.toFixed(2)})`);
                }
              } else {
                logJobMessage(jobsState, `⚠️ AI Enrichment failed/skipped for "${job.job_title}": ${res.error || 'unsupported'}`);
              }
            } catch (err: any) {
              console.error(`Error enriching job ${job.job_url}:`, err.message);
            }
          })
        );
        saveJobState(jobsState);
        if (i + batchSize < toEnrich.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
      logJobMessage(jobsState, '✨ Phase 3: AI Enrichment complete.');
      saveJobState(jobsState);
    }

    // Comparison Engine (OPEN vs CLOSED vs UPDATED)
    const previousJobsMap = new Map<string, ScrapedJob>();
    const previousJobsList = isPgAvailable ? await dbLoadJobs() : jobsState.jobs;
    previousJobsList.forEach(j => previousJobsMap.set(j.job_id, j));

    // Map from normalized group key to existing job to prevent cross-run duplicates from different sources/URLs
    const previousJobsGroupMap = new Map<string, ScrapedJob>();
    previousJobsList.forEach(j => {
      const normTitle = j.job_title.toLowerCase().replace(/\s+/g, '');
      const normCompany = normalizeCompanyName(j.company_name).toLowerCase();
      const normLoc = j.location.toLowerCase().replace(/\s+/g, '');
      const groupKey = `${normCompany}|${normTitle}|${normLoc}`;

      const existing = previousJobsGroupMap.get(groupKey);
      if (!existing || new Date(j.last_seen_timestamp) > new Date(existing.last_seen_timestamp)) {
        previousJobsGroupMap.set(groupKey, j);
      }
    });

    const discoveredJobIds = new Set<string>();
    const processedPrevJobIds = new Set<string>();
    let newJobsFound = 0;
    let updatedJobsFound = 0;

    const nextJobsStateList: ScrapedJob[] = [];

    // 1. Process discovered jobs
    for (const job of uniqueCandidateJobs) {
      const normTitle = job.job_title.toLowerCase().replace(/\s+/g, '');
      const normCompany = normalizeCompanyName(job.company_name).toLowerCase();
      const normLoc = job.location.toLowerCase().replace(/\s+/g, '');
      const groupKey = `${normCompany}|${normTitle}|${normLoc}`;

      const existingJobByGroup = previousJobsGroupMap.get(groupKey);

      if (existingJobByGroup) {
        // Match found by company/title/location - update existing instead of creating a duplicate with a new hash/URL
        processedPrevJobIds.add(existingJobByGroup.job_id);
        discoveredJobIds.add(existingJobByGroup.job_id);

        const isFieldUpdated =
          existingJobByGroup.location !== job.location ||
          existingJobByGroup.work_mode !== job.work_mode ||
          existingJobByGroup.status !== 'OPEN';

        if (isFieldUpdated) {
          updatedJobsFound++;
        }

        const updatedJob: ScrapedJob = {
          ...existingJobByGroup,
          ...job,
          job_id: existingJobByGroup.job_id, // Keep the original ID
          job_fingerprint: existingJobByGroup.job_fingerprint || existingJobByGroup.job_id,
          id: existingJobByGroup.id || existingJobByGroup.job_id,

          first_seen_timestamp: existingJobByGroup.first_seen_timestamp,
          last_seen_timestamp: new Date().toISOString(),
          status: 'OPEN'
        };
        nextJobsStateList.push(updatedJob);
        const upsert = updatedJob.ai_extracted ? dbUpsertAiJob : dbUpsertJob;
        upsert(updatedJob).catch(err => console.error(err));
      } else {
        // Genuinely new job
        discoveredJobIds.add(job.job_id);
        nextJobsStateList.push(job);
        newJobsFound++;
        const upsert = job.ai_extracted ? dbUpsertAiJob : dbUpsertJob;
        upsert(job).catch(err => console.error(err));
      }
    }

    // 2. Process closed jobs
    let closedJobsFound = 0;
    for (const prevJob of previousJobsList) {
      if (processedPrevJobIds.has(prevJob.job_id)) {
        // Already updated and pushed in step 1
        continue;
      }
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

export async function runCustomJobSearch(
  query: string,
  engines: string[] = ['ddg', 'yahoo', 'bing', 'brave'],
  indiaOnly: boolean = true
): Promise<any[]> {
  const searchResults: { url: string; title: string; description: string }[] = [];
  const promises: Promise<{ url: string; title: string; description: string }[]>[] = [];

  if (engines.includes('ddg')) promises.push(queryDDGJobs(query).catch(() => []));
  if (engines.includes('yahoo')) promises.push(queryYahooJobs(query).catch(() => []));
  if (engines.includes('bing')) promises.push(queryBingJobs(query).catch(() => []));
  if (engines.includes('brave')) promises.push(queryBraveJobs(query).catch(() => []));

  const settled = await Promise.allSettled(promises);
  settled.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      searchResults.push(...r.value);
    }
  });

  const uniqueJobs: any[] = [];
  const seenUrls = new Set<string>();

  for (const res of searchResults) {
    const urlStr = res.url.split('?')[0];
    if (seenUrls.has(urlStr.toLowerCase())) continue;

    const { company, title } = parseCompanyAndTitle(res.url, res.title);

    if (!isValidJobPage(res.url, title)) {
      continue;
    }

    if (indiaOnly && !isIndiaSearchResult(res.title, res.description, res.url)) {
      continue;
    }

    seenUrls.add(urlStr.toLowerCase());

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
    } catch {
      careerPageUrl = res.url;
    }

    let companyWebsite = '';
    const isAts = ['Lever', 'Greenhouse', 'Workday', 'Ashby', 'SmartRecruiters', 'BambooHR', 'Taleo', 'iCIMS', 'SuccessFactors'].includes(sourceName);
    const isJobBoard = ['LinkedIn', 'Naukri', 'Indeed', 'Glassdoor', 'Wellfound', 'Instahyre', 'CutShort', 'Hirist', 'Internshala', 'Foundit', 'Monster', 'Shine', 'AmbitionBox'].includes(sourceName);
    if (!isAts && !isJobBoard) {
      try {
        const parsed = new URL(res.url);
        companyWebsite = `${parsed.protocol}//${parsed.hostname}`;
      } catch {}
    }

    const workMode = extractWorkMode(title, res.description);
    const cityState = parseCityAndState(title, res.description, res.url, 'India');

    const partialJob = {
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

    uniqueJobs.push({
      ...partialJob,
      job_id: fingerprint,
      job_fingerprint: fingerprint,
      id: fingerprint,
      title,
      companyName: company,
      url: res.url,
      postedDate: new Date().toISOString(),
      scrapedAt: new Date().toISOString()
    });
  }

  return uniqueJobs;
}

export async function extractJobsFromUrl(urlStr: string): Promise<any[]> {
  const url = urlStr.trim();
  if (!url || !url.startsWith('http')) {
    throw new Error('Invalid URL. URL must start with http:// or https://');
  }

  // 1. Check for ATS boards and use public JSON API
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // A. Greenhouse board
    if (host.includes('greenhouse.io')) {
      const parts = pathname.split('/').filter(Boolean);
      let companySlug = '';
      if (parts[0] === 'embed' && parts[1] === 'job_board') {
        companySlug = parsed.searchParams.get('for') || '';
      } else if (parts[0]) {
        companySlug = parts[0];
      }
      if (companySlug && companySlug !== 'embed' && companySlug !== 'jobs') {
        const jobs = await fetchGreenhouseJobs(companySlug);
        if (jobs.length > 0) {
          return formatJobItemsToScrapedJobs(jobs, 'Greenhouse', companySlug);
        }
      }
    }

    // B. Lever board
    if (host.includes('lever.co')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0]) {
        const companySlug = parts[0];
        if (parts.length === 1) {
          const jobs = await fetchLeverJobs(companySlug);
          if (jobs.length > 0) {
            return formatJobItemsToScrapedJobs(jobs, 'Lever', companySlug);
          }
        }
      }
    }

    // C. Ashby board
    if (host.includes('ashbyhq.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] && parts.length === 1) {
        const companySlug = parts[0];
        const jobs = await fetchAshbyJobs(companySlug);
        if (jobs.length > 0) {
          return formatJobItemsToScrapedJobs(jobs, 'Ashby', companySlug);
        }
      }
    }

    // D. SmartRecruiters board
    if (host.includes('smartrecruiters.com')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] && parts.length === 1) {
        const companySlug = parts[0];
        const jobs = await fetchSmartRecruitersJobs(companySlug);
        if (jobs.length > 0) {
          return formatJobItemsToScrapedJobs(jobs, 'SmartRecruiters', companySlug);
        }
      }
    }
  } catch (e) {
    console.error('Error checking ATS slug in extractJobsFromUrl:', e);
  }

  // 2. Fetch page HTML
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  // 3. Heuristics to decide if we parse it as multiple job links or a single job page.
  const pageUrlObj = new URL(url);
  const baseUrl = `${pageUrlObj.protocol}//${pageUrlObj.hostname}`;

  const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const uniqueLinks = new Map<string, string>(); // href -> link text

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    
    try {
      const absoluteUrl = new URL(href, url).href;
      const cleanHref = absoluteUrl.split('?')[0].toLowerCase();
      
      if (isValidJobPage(absoluteUrl, match[2])) {
        if (cleanHref !== url.split('?')[0].toLowerCase()) {
          uniqueLinks.set(absoluteUrl, cleanHtmlText(match[2]));
        }
      }
    } catch {}
  }

  // If we found more than 2 potential job links, treat the page as a Careers/List page!
  if (uniqueLinks.size > 2) {
    const discoveredJobs: any[] = [];
    const company = extractCompanyNameFromUrl(url, html);

    for (const [jobUrl, linkText] of uniqueLinks.entries()) {
      const title = cleanJobTitle(linkText);
      const cityState = parseCityAndState(title, '', jobUrl, 'India');
      const workMode = extractWorkMode(title, jobUrl);
      const skills = extractSkills(title, '');
      
      const partialJob = {
        job_title: title,
        company_name: company,
        company_website: baseUrl,
        career_page_url: url,
        job_url: jobUrl,
        location: cityState.city ? `${cityState.city}, ${cityState.state}, India` : 'India',
        city: cityState.city,
        state: cityState.state,
        country: 'India',
        employment_type: extractEmploymentType(title, ''),
        work_mode: workMode,
        experience_required: extractExperience(title, ''),
        skills: skills,
        department: '',
        posted_date: new Date().toISOString(),
        application_deadline: '',
        source_type: 'OFFICIAL' as const,
        source_name: 'Manual URL Extraction',
        description: `Discovered job listing: ${title}. Visit ${jobUrl} to apply.`,
        apply_url: jobUrl,

        // Compatibility keys
        id: '',
        title: title,
        companyName: company,
        url: jobUrl,
        scrapedAt: new Date().toISOString(),
        postedDate: new Date().toISOString(),
        remote: workMode === 'remote',
        salary: '',
        salary_range: ''
      };

      const fingerprint = generateJobFingerprint(partialJob);
      discoveredJobs.push({
        ...partialJob,
        job_id: fingerprint,
        job_fingerprint: fingerprint,
        id: fingerprint
      });
    }

    return discoveredJobs;
  }

  // Otherwise, treat the page as a single job posting!
  const title = extractTitleFromHtml(html, url);
  const company = extractCompanyNameFromUrl(url, html);
  const description = extractDescriptionFromHtml(html);
  
  const cityState = parseCityAndState(title, description, url, 'India');
  const workMode = extractWorkMode(title, description);
  const skills = extractSkills(title, description);
  const empType = extractEmploymentType(title, description);
  const exp = extractExperience(title, description);

  const partialJob = {
    job_title: title,
    company_name: company,
    company_website: baseUrl,
    career_page_url: url,
    job_url: url,
    location: cityState.city ? `${cityState.city}, ${cityState.state}, India` : 'India',
    city: cityState.city,
    state: cityState.state,
    country: 'India',
    employment_type: empType,
    work_mode: workMode,
    experience_required: exp,
    skills: skills,
    department: '',
    posted_date: new Date().toISOString(),
    application_deadline: '',
    source_type: 'OFFICIAL' as const,
    source_name: 'Manual URL Extraction',
    description: description.slice(0, 1000) || `Job posting for ${title} at ${company}.`,
    apply_url: url,

    // Compatibility keys
    id: '',
    title: title,
    companyName: company,
    url: url,
    scrapedAt: new Date().toISOString(),
    postedDate: new Date().toISOString(),
    remote: workMode === 'remote',
    salary: '',
    salary_range: ''
  };

  const fingerprint = generateJobFingerprint(partialJob);
  return [{
    ...partialJob,
    job_id: fingerprint,
    job_fingerprint: fingerprint,
    id: fingerprint
  }];
}

// Format JobItem[] from Greenhouse/Lever APIs into ScrapedJob objects
function formatJobItemsToScrapedJobs(items: JobItem[], sourceName: string, companySlug: string): any[] {
  return items.map(j => {
    const company = j.companyName
      ? j.companyName.replace(/\b\w/g, c => c.toUpperCase())
      : companySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const cityState = parseCityAndState(j.title, j.description, j.url, j.location);
    const skills = extractSkills(j.title, j.description);
    const workMode = extractWorkMode(j.title, `${j.description} ${j.location}`);
    const empType = extractEmploymentType(j.title, j.description);
    const exp = extractExperience(j.title, j.description);
    const salary = extractSalary(j.title, j.description);
    const fingerprint = generateJobFingerprint({ job_url: j.url, company_name: company, job_title: j.title, location: j.location });

    const partialJob = {
      job_title: j.title,
      company_name: company,
      company_website: j.companyName ? '' : '', // Let it be mapped correctly
      career_page_url: j.url,
      job_url: j.url,
      location: cityState.city ? `${cityState.city}, ${cityState.state}, India` : j.location || 'India',
      city: cityState.city,
      state: cityState.state,
      country: 'India',
      employment_type: empType,
      work_mode: workMode,
      experience_required: exp,
      skills: skills,
      department: '',
      posted_date: new Date().toISOString(),
      application_deadline: '',
      source_type: 'OFFICIAL' as const,
      source_name: sourceName,
      description: j.description || `Job posting for ${j.title} at ${company}.`,
      apply_url: j.url,

      // Compatibility keys
      id: '',
      title: j.title,
      companyName: company,
      url: j.url,
      scrapedAt: new Date().toISOString(),
      postedDate: new Date().toISOString(),
      remote: workMode === 'remote',
      salary: salary,
      salary_range: salary
    };

    return {
      ...partialJob,
      job_id: fingerprint,
      job_fingerprint: fingerprint,
      id: fingerprint
    };
  });
}

function extractTitleFromHtml(html: string, url: string): string {
  const ogTitleMatch = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html) ||
                       /<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i.exec(html);
  if (ogTitleMatch) return cleanJobTitle(ogTitleMatch[1]);

  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1Match) return cleanJobTitle(h1Match[1]);

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) return cleanJobTitle(titleMatch[1]);

  return 'Job Opening';
}

function extractDescriptionFromHtml(html: string): string {
  let bodyContent = html.replace(/<head[\s\S]*?<\/head>/gi, '')
                        .replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                        .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  let cleaned = bodyContent.replace(/<[^>]*>/g, ' ');

  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned.slice(0, 3000);
}

function cleanJobTitle(title: string): string {
  let clean = cleanHtmlText(title);
  clean = clean.replace(/\s*[-|]\s*[A-Za-z0-9\s]+$/g, '');
  clean = clean.replace(/\s+careers?\b/gi, '');
  return clean.trim();
}

function extractCompanyNameFromUrl(urlStr: string, html: string): string {
  const ogSiteMatch = /<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i.exec(html) ||
                      /<meta[^>]+content="([^"]+)"[^>]+property="og:site_name"/i.exec(html);
  if (ogSiteMatch) return ogSiteMatch[1].trim();

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) {
    const titleText = cleanHtmlText(titleMatch[1]);
    const atMatch = /\b(?:at|@|in|hiring at|careers at)\s+([A-Za-z0-9\s]+)/i.exec(titleText);
    if (atMatch) {
      return atMatch[1].trim().split('|')[0].split('-')[0].trim();
    }
  }

  try {
    const parsed = new URL(urlStr);
    const parts = parsed.hostname.split('.');
    let name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    if (name === 'co' || name === 'com' || name === 'net' || name === 'org') {
      name = parts[0];
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'Live Discovered Co';
  }
}

