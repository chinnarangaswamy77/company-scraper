import fs from 'fs';
import path from 'path';

// Define structures
export interface ScrapedCompany {
  name: string;
  website: string;
  careers: string;
  status: 'pending' | 'success' | 'failed';
  verified?: boolean;
  isFake?: boolean;
  isScam?: boolean; // Flagged as placement fee charging scam
  error?: string;
  timestamp?: string;
  jobTracked?: boolean;
}

export interface ScrapeState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped';
  companies: ScrapedCompany[];
  currentIndex: number;
  total: number;
  startTime: string | null;
  endTime: string | null;
  logs: string[];
  delayMs: number;
  concurrency: number;
  removedScamsCount?: number;
  searchEngine?: 'all' | 'heuristics_first' | 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage' | 'guess';
  blacklistDomains?: string[];
  scamKeywords?: string[];
  engineStatus?: {
    ddg: 'healthy' | 'error';
    yahoo: 'healthy' | 'error';
    bing: 'healthy' | 'error';
    ask: 'healthy' | 'error';
    aol: 'healthy' | 'error';
    brave: 'healthy' | 'error';
    qwant: 'healthy' | 'error';
    startpage: 'healthy' | 'error';
  };
  storageSize?: string;
}

function getStorageSize(): string {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const stats = fs.statSync(STATE_FILE);
      const kb = stats.size / 1024;
      return kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(2)} KB`;
    }
  } catch (e) {}
  return '0 KB';
}

const DEFAULT_BLACKLIST_DOMAINS = [
  'linkedin.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'glassdoor.co',
  'naukri.com',
  'ambitionbox.com',
  'youtube.com',
  'wikipedia.org',
  'indiamart.com',
  'justdial.com'
];

const DEFAULT_SCAM_KEYWORDS = [
  'registration fee',
  'placement fee',
  'placement charges',
  'security deposit',
  'caution money',
  'caution deposit',
  'caution fee',
  'training fee',
  'placement fee of',
  'pay for placement',
  'pay for job',
  'pay for interview',
  'charges for placement'
];

// User Agent pool to bypass bot detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

// Path to save state
const STATE_FILE = path.join('/Users/ravipatichinnaranga/.gemini/antigravity-ide/scratch', 'scraper_progress.json');

// Memory cache as fallback
let inMemoryState: ScrapeState | null = null;
let activeTimers: NodeJS.Timeout[] = [];

export function getInitialState(companiesList: (string | Partial<ScrapedCompany>)[] = []): ScrapeState {
  const uniqueMap = new Map<string, Partial<ScrapedCompany>>();
  companiesList.forEach(item => {
    const name = typeof item === 'string' ? item.trim() : item.name?.trim();
    if (name) {
      if (!uniqueMap.has(name)) {
        uniqueMap.set(name, typeof item === 'string' ? { name } : item);
      }
    }
  });

  const uniqueCompanies: ScrapedCompany[] = Array.from(uniqueMap.values()).map((c, index) => ({
    name: c.name!,
    website: c.website || 'N/A',
    careers: c.careers || 'N/A',
    status: c.status || 'pending',
    verified: c.verified || false,
    timestamp: c.timestamp || new Date().toISOString(),
    isScam: c.isScam || false,
    isFake: c.isFake || false,
    jobTracked: c.jobTracked !== undefined ? c.jobTracked : (index < 20)
  }));

  return {
    status: 'idle',
    companies: uniqueCompanies,
    currentIndex: 0,
    total: uniqueCompanies.length,
    startTime: null,
    endTime: null,
    logs: ['Scraper initialized. Upload a list or use defaults to begin.'],
    delayMs: 500, // Default 500ms delay (fast)
    concurrency: 5, // Default 5 concurrent workers
    removedScamsCount: 0,
    searchEngine: 'heuristics_first',
    blacklistDomains: DEFAULT_BLACKLIST_DOMAINS,
    scamKeywords: DEFAULT_SCAM_KEYWORDS,
    engineStatus: {
      ddg: 'healthy',
      yahoo: 'healthy',
      bing: 'healthy',
      ask: 'healthy',
      aol: 'healthy',
      brave: 'healthy',
      qwant: 'healthy',
      startpage: 'healthy'
    }
  };
}

export function loadState(defaultCompanies: string[] = []): ScrapeState {
  if (inMemoryState) {
    return inMemoryState;
  }
  
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf-8');
      inMemoryState = JSON.parse(content);
      // Ensure defaults are populated if missing in old state
      if (inMemoryState) {
        if (typeof inMemoryState.concurrency === 'undefined') inMemoryState.concurrency = 5;
        if (typeof inMemoryState.removedScamsCount === 'undefined') inMemoryState.removedScamsCount = 0;
        if (typeof inMemoryState.searchEngine === 'undefined') inMemoryState.searchEngine = 'heuristics_first';
        if (typeof inMemoryState.blacklistDomains === 'undefined') inMemoryState.blacklistDomains = DEFAULT_BLACKLIST_DOMAINS;
        if (typeof inMemoryState.scamKeywords === 'undefined') inMemoryState.scamKeywords = DEFAULT_SCAM_KEYWORDS;
        if (!inMemoryState.engineStatus) {
          inMemoryState.engineStatus = {
            ddg: 'healthy',
            yahoo: 'healthy',
            bing: 'healthy',
            ask: 'healthy',
            aol: 'healthy',
            brave: 'healthy',
            qwant: 'healthy',
            startpage: 'healthy'
          };
        } else {
          if (typeof inMemoryState.engineStatus.bing === 'undefined') inMemoryState.engineStatus.bing = 'healthy';
          if (typeof inMemoryState.engineStatus.ask === 'undefined') inMemoryState.engineStatus.ask = 'healthy';
          if (typeof inMemoryState.engineStatus.aol === 'undefined') inMemoryState.engineStatus.aol = 'healthy';
          if (typeof inMemoryState.engineStatus.brave === 'undefined') inMemoryState.engineStatus.brave = 'healthy';
          if (typeof inMemoryState.engineStatus.qwant === 'undefined') inMemoryState.engineStatus.qwant = 'healthy';
          if (typeof inMemoryState.engineStatus.startpage === 'undefined') inMemoryState.engineStatus.startpage = 'healthy';
        }
        inMemoryState.storageSize = getStorageSize();
        if (inMemoryState.companies) {
          inMemoryState.companies.forEach((c, index) => {
            if (typeof c.jobTracked === 'undefined') {
              c.jobTracked = index < 20;
            }
          });
        }
      }
      return inMemoryState!;
    }
  } catch (error) {
    console.error('Failed to load state file:', error);
  }
  
  inMemoryState = getInitialState(defaultCompanies);
  saveStateToDisk();
  return inMemoryState;
}

export function saveState(state: ScrapeState) {
  inMemoryState = state;
  saveStateToDisk();
}

function saveStateToDisk() {
  if (!inMemoryState) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(inMemoryState, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write state file:', error);
  }
}

const IGNORED_DOMAINS = [
  'duckduckgo.com',
  'yahoo.com',
  'google.com',
  'bing.com',
  'ask.com',
  'aol.com',
  'brave.com',
  'qwant.com',
  'startpage.com',
  'w3.org',
  'yimg.com',
  'microsoft.com',
  'live.com',
  'bingj.com',
  'schema.org'
];

// Extract URLs from Search Engine response HTML
function extractUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  let match;

  const isIgnored = (urlStr: string) => {
    const lower = urlStr.toLowerCase();
    return IGNORED_DOMAINS.some(domain => lower.includes(domain));
  };

  // Try matching Yahoo redirect links specifically: r.search.yahoo.com/**/RU=http.../RK=2
  const yahooRedirectRegex = /RU=([^/&"' >]+)/g;
  while ((match = yahooRedirectRegex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.startsWith('http') && !isIgnored(decoded)) {
        if (!urls.includes(decoded)) {
          urls.push(decoded);
        }
      }
    } catch (e) {}
  }
  
  // Look for redirect links like: /l/?kh=-1&uddg=https%3A%2F%2Fwww.tcs.com%2F
  const uddgRegex = /uddg=([^&"' >]+)/g;
  while ((match = uddgRegex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.startsWith('http') && !isIgnored(decoded)) {
        if (!urls.includes(decoded)) {
          urls.push(decoded);
        }
      }
    } catch (e) {}
  }

  // Fallback: search for any raw link in href attribute
  const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/g;
  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1];
    if (!isIgnored(url)) {
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }
  
  return urls;
}

// Fetch search results from DuckDuckGo HTML using POST
async function searchDuckDuckGo(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://html.duckduckgo.com/html/`;
  
  const headers = {
    'User-Agent': userAgent,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://html.duckduckgo.com/'
  };

  // No artificial delay — parallel races + worker-level delay handle timing
  const response = await fetch(url, { 
    method: 'POST', 
    headers,
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(3000)
  });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by DuckDuckGo');
    }
    throw new Error(`DuckDuckGo returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from Yahoo Search using GET
async function searchYahoo(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://search.yahoo.com/'
  };

  // No artificial delay
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Yahoo');
    }
    throw new Error(`Yahoo returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Heuristic rule-based domain guesser (predicts domain based on company name)
function guessCompanyUrls(companyName: string, suffix = '.com'): { website: string; careers: string } {
  let cleanName = companyName.toLowerCase();
  
  // Strip common suffixes, abbreviations and brackets
  cleanName = cleanName.replace(/\([^)]*\)/g, ''); // strip e.g. "(TCS)"
  cleanName = cleanName.replace(/\b(india|pvt|ltd|limited|technologies|solutions|software|systems|services|it|consulting|group|engineering|centre|center|global|corporation|corp|inc)\b/g, '');
  cleanName = cleanName.trim().replace(/[^a-z0-9]/g, '');
  
  if (!cleanName || cleanName.length < 2) {
    // Fallback to first word of company name
    cleanName = companyName.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const domain = `${cleanName}${suffix}`;
  const website = `https://www.${domain}`;
  const careers = `${website}/careers`;
  
  return { website, careers };
}

// Clean and categorize homepage vs careers page
function processUrls(companyName: string, urls: string[], blacklist: string[] = DEFAULT_BLACKLIST_DOMAINS): { website: string; careers: string } {
  if (urls.length === 0) {
    return { website: 'N/A', careers: 'N/A' };
  }

  // Clean company name for matching
  const cleanName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  let homepage = '';
  let careers = '';

  // Filter out social and job aggregates based on custom blacklist
  const filtered = urls.filter(u => 
    !blacklist.some(domain => u.toLowerCase().includes(domain.toLowerCase()))
  );

  const candidates = filtered.length > 0 ? filtered : urls;

  // Identify careers link
  const careerKeywords = ['career', 'job', 'opening', 'join', 'work', 'hr', 'vacancy', 'recruit', 'hiring'];
  const careerUrls = candidates.filter(u => careerKeywords.some(keyword => u.toLowerCase().includes(keyword)));
  
  if (careerUrls.length > 0) {
    careers = careerUrls[0];
  }

  // Identify homepage
  const domainMatches = candidates.filter(u => {
    try {
      const urlObj = new URL(u);
      const host = urlObj.hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
      return host.includes(cleanName.slice(0, 6)) || cleanName.includes(host.slice(0, 6));
    } catch {
      return false;
    }
  });

  if (domainMatches.length > 0) {
    domainMatches.sort((a, b) => {
      try {
        return new URL(a).pathname.length - new URL(b).pathname.length;
      } catch {
        return 0;
      }
    });
    homepage = domainMatches[0];
  } else {
    homepage = candidates[0];
  }

  // Extract base domain for homepage
  try {
    const urlObj = new URL(homepage);
    homepage = `${urlObj.protocol}//${urlObj.hostname}`;
  } catch {
    // Keep raw
  }

  // Fallback for careers if not found
  if (!careers && homepage && homepage !== 'N/A') {
    careers = `${homepage}/careers`;
  }

  return {
    website: homepage || 'N/A',
    careers: careers || 'N/A'
  };
}

// Fetch search results from Bing Search using GET
async function searchBing(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.bing.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Bing');
    }
    throw new Error(`Bing returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from Ask.com using GET
async function searchAsk(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://www.ask.com/web?q=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.ask.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Ask');
    }
    throw new Error(`Ask returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from AOL using GET
async function searchAol(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://search.aol.com/aol/search?q=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://search.aol.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by AOL');
    }
    throw new Error(`AOL returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from Brave Search using GET
async function searchBrave(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://search.brave.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Brave');
    }
    throw new Error(`Brave returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from Qwant Search using GET
async function searchQwant(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://www.qwant.com/?q=${encodeURIComponent(query)}&t=web`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.qwant.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Qwant');
    }
    throw new Error(`Qwant returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Fetch search results from Startpage using GET
async function searchStartpage(query: string, delayMs: number): Promise<string[]> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const url = `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
  
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.startpage.com/'
  };

  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Startpage');
    }
    throw new Error(`Startpage returned status ${response.status}`);
  }

  const html = await response.text();
  return extractUrlsFromHtml(html);
}

// Helper to query search engine by key
async function querySearchEngine(
  name: 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage',
  query: string,
  delayMs: number
): Promise<string[]> {
  switch (name) {
    case 'ddg':
      return await searchDuckDuckGo(query, delayMs);
    case 'yahoo':
      return await searchYahoo(query, delayMs);
    case 'bing':
      return await searchBing(query, delayMs);
    case 'ask':
      return await searchAsk(query, delayMs);
    case 'aol':
      return await searchAol(query, delayMs);
    case 'brave':
      return await searchBrave(query, delayMs);
    case 'qwant':
      return await searchQwant(query, delayMs);
    case 'startpage':
      return await searchStartpage(query, delayMs);
  }
}

// Helper to update engine health status in global state
function updateEngineStatus(engineKey: 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage', status: 'healthy' | 'error') {
  if (inMemoryState) {
    if (!inMemoryState.engineStatus) {
      inMemoryState.engineStatus = {
        ddg: 'healthy',
        yahoo: 'healthy',
        bing: 'healthy',
        ask: 'healthy',
        aol: 'healthy',
        brave: 'healthy',
        qwant: 'healthy',
        startpage: 'healthy'
      };
    }
    inMemoryState.engineStatus[engineKey] = status;
  }
}

// Helper to try heuristic URL probe in parallel — returns as soon as the FIRST suffix responds
async function tryHeuristics(companyName: string): Promise<{ website: string; careers: string; source: string } | null> {
  // Expanded suffix list to cover more Indian & global company TLDs
  const suffixes = ['.com', '.in', '.co.in', '.net', '.org', '.io', '.co', '.tech', '.ai'];

  // Race all suffix probes — return the moment any single one responds
  let workingResult: { suffix: string; guess: { website: string; careers: string } } | null = null;
  try {
    workingResult = await Promise.any(
      suffixes.map(async (suffix) => {
        const guess = guessCompanyUrls(companyName, suffix);
        const isWebOk = await verifyUrl(guess.website);
        if (!isWebOk) throw new Error('offline');
        return { suffix, guess };
      })
    );
  } catch {
    return null; // All suffixes offline
  }

  const { suffix, guess } = workingResult;
  const bestGuess = {
    website: guess.website,
    careers: guess.careers,
    source: `Heuristic Guess (Verified ${suffix})`
  };

  // Check careers paths in parallel and take the first working one
  const commonPaths = ['/careers', '/jobs', '/careers-page', '/join-us', '/work-with-us', '/about/careers', '/company/careers'];
  const careersPaths = [
    guess.careers,
    ...commonPaths.map(p => guess.website.endsWith('/') ? `${guess.website.slice(0, -1)}${p}` : `${guess.website}${p}`)
  ];

  try {
    const workingCareers = await Promise.any(
      careersPaths.map(async path => {
        const ok = await verifyUrl(path);
        if (!ok) throw new Error('offline');
        return path;
      })
    );
    bestGuess.careers = workingCareers;
  } catch { /* No careers path found — keep the guessed one */ }

  return bestGuess;
}

// Scrape single company with DDG, Yahoo, and Heuristic Guess modes
export async function scrapeCompany(
  companyName: string, 
  delayMs: number,
  engine: 'all' | 'heuristics_first' | 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage' | 'guess' = 'heuristics_first',
  blacklist: string[] = DEFAULT_BLACKLIST_DOMAINS
): Promise<{ website: string; careers: string; source: string }> {
  // 1. If heuristics_first or guess, try direct verification first (super fast now)
  if (engine === 'heuristics_first' || engine === 'guess') {
    const heuristicsResult = await tryHeuristics(companyName);
    if (heuristicsResult) {
      return heuristicsResult;
    }
  }

  // If guess only, we don't query online besides suffix probe fallback above
  if (engine === 'guess') {
    const defaultGuess = guessCompanyUrls(companyName, '.com');
    return {
      website: defaultGuess.website,
      careers: defaultGuess.careers,
      source: 'Heuristic Guess (Direct)'
    };
  }

  const query = `${companyName} India official website careers`;

  // Determine which engines to query
  type EngineKey = 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage';
  let enginesToTry: EngineKey[] = [];
  if (engine === 'all' || engine === 'heuristics_first') {
    enginesToTry = ['ddg', 'yahoo', 'bing', 'ask', 'aol', 'brave', 'qwant', 'startpage'];
  } else {
    enginesToTry = [engine as EngineKey];
  }

  // Filter out engines that are currently dead to avoid hammering them / wasting time
  let healthyEngines = enginesToTry;
  if (inMemoryState && inMemoryState.engineStatus) {
    healthyEngines = enginesToTry.filter(eng => inMemoryState!.engineStatus![eng] === 'healthy');
    // If all are dead, reset them to healthy to try fresh
    if (healthyEngines.length === 0) {
      enginesToTry.forEach(eng => updateEngineStatus(eng, 'healthy'));
      healthyEngines = enginesToTry;
    }
  }

  // ⚡ PARALLEL RACE: fire the healthy engines simultaneously, first to return organic results wins
  const racePromises = healthyEngines.map(eng =>
    querySearchEngine(eng, query, 0)
      .then(urls => {
        // Successful response (even if 0 urls) means the engine API is online and healthy
        updateEngineStatus(eng, 'healthy');
        if (urls.length === 0) {
          throw new Error('no results'); // throw to skip in Promise.any
        }
        const processed = processUrls(companyName, urls, blacklist);
        return {
          website: processed.website,
          careers: processed.careers,
          source: `Search Engine (${eng.toUpperCase()})`
        };
      })
      .catch(err => {
        // Only mark as error if it is an actual HTTP/network error, not just 0 results
        if (err.message !== 'no results') {
          updateEngineStatus(eng, 'error');
        }
        throw err;
      })
  );

  try {
    const winner = await Promise.any(racePromises);
    return winner;
  } catch {
    // If all search engines fail/return no results, try heuristics fallback if not already run
    if (engine !== 'heuristics_first') {
      const heuristicsResult = await tryHeuristics(companyName);
      if (heuristicsResult) {
        return heuristicsResult;
      }
    }
  }

  const defaultGuess = guessCompanyUrls(companyName, '.com');
  return {
    website: defaultGuess.website,
    careers: defaultGuess.careers,
    source: 'Heuristic Guess (Search Blocked)'
  };
}

// Add log entry and rotate if too large
function logMessage(state: ScrapeState, message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const log = `[${timestamp}] ${message}`;
  state.logs.push(log);
  if (state.logs.length > 200) {
    state.logs.shift();
  }
}

// Helper to verify if a URL is valid — races HEAD and GET simultaneously, returns true on first success
async function verifyUrl(url: string): Promise<boolean> {
  if (!url || url === 'N/A' || !url.startsWith('http')) return false;
  try {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const opts = (method: string) => ({
      method,
      headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow' as RequestRedirect,
      signal: AbortSignal.timeout(5000) // Increased to 5s for slow sites
    });
    // Race HEAD and GET — whichever resolves first wins
    // Accept any 2xx OR 3xx redirect as "alive" (many sites redirect http->https or www->non-www)
    const result = await Promise.any([
      fetch(url, opts('HEAD')).then(r => {
        if (r.status >= 200 && r.status < 400) return true;
        throw new Error('not ok');
      }),
      fetch(url, opts('GET')).then(r => {
        if (r.status >= 200 && r.status < 400) return true;
        throw new Error('not ok');
      })
    ]);
    return result;
  } catch {
    return false;
  }
}

// Helper to fetch page and scan for money-charging scam keywords
async function checkForFeeScam(url: string, scamKeywords: string[] = DEFAULT_SCAM_KEYWORDS): Promise<boolean> {
  if (!url || url === 'N/A' || !url.startsWith('http')) return false;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      },
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return false;
    const text = await res.text();
    const lowerText = text.toLowerCase();
    
    for (const phrase of scamKeywords) {
      let index = lowerText.indexOf(phrase.toLowerCase());
      while (index !== -1) {
        // Look at the context window of 100 characters before the match for negations or disclaimers
        const start = Math.max(0, index - 100);
        const context = lowerText.substring(start, index);
        
        const hasNegation = [
          'does not',
          'do not',
          'never',
          'no ',
          'not ask',
          'not request',
          'free of',
          'without',
          'fake',
          'fraud',
          'scam',
          'beware'
        ].some(neg => context.includes(neg));
        
        if (!hasNegation) {
          return true; // Actual scam (charges money without disclaimer)
        }
        
        index = lowerText.indexOf(phrase.toLowerCase(), index + phrase.length);
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

// Worker thread logic
async function runWorker(workerId: number) {
  if (!inMemoryState || inMemoryState.status !== 'running') {
    return;
  }

  const state = inMemoryState;
  
  // Pull next item atomically
  const indexToProcess = state.currentIndex;
  if (indexToProcess >= state.companies.length) {
    const activeWorkers = state.companies.filter(c => c.status === 'pending').length;
    if (activeWorkers === 0 && state.status === 'running') {
      state.status = 'completed';
      state.endTime = new Date().toISOString();
      logMessage(state, '🎉 Extraction complete! All companies processed.');
      saveState(state);
    }
    return;
  }

  // Claim the company index
  state.currentIndex++;
  const company = state.companies[indexToProcess];
  logMessage(state, `[Worker ${workerId}] Scraping (${indexToProcess + 1}/${state.companies.length}): "${company.name}"`);
  saveState(state);

  try {
    let results;
    const hasPrepopulatedUrl = (company.website && company.website !== 'N/A') || 
                               (company.careers && company.careers !== 'N/A');

    if (hasPrepopulatedUrl) {
      logMessage(state, `[Worker ${workerId}] Verifying existing URL(s) for "${company.name}": Web: ${company.website || 'N/A'} | Careers: ${company.careers || 'N/A'}`);
      
      let [isWebOk, isCareersOk] = await Promise.all([
        company.website && company.website !== 'N/A' ? verifyUrl(company.website) : Promise.resolve(false),
        company.careers && company.careers !== 'N/A' ? verifyUrl(company.careers) : Promise.resolve(false)
      ]);

      // If website is working but careers is missing/dead, try guessing paths on the website domain in parallel
      if (isWebOk && !isCareersOk && company.website) {
        const commonPaths = ['/careers', '/jobs', '/careers-page', '/join-us', '/work-with-us'];
        const paths = commonPaths.map(p => company.website.endsWith('/') ? `${company.website.slice(0, -1)}${p}` : `${company.website}${p}`);
        const pathResults = await Promise.all(paths.map(async (path) => {
          const ok = await verifyUrl(path);
          return ok ? path : null;
        }));
        const workingPath = pathResults.find(p => p !== null);
        if (workingPath) {
          company.careers = workingPath;
          isCareersOk = true;
          logMessage(state, `[Worker ${workerId}] Found careers page for "${company.name}" under domain: ${workingPath}`);
        }
      }

      // If careers is working but website is missing/dead, try extracting base homepage URL
      if (!isWebOk && isCareersOk && company.careers) {
        try {
          const urlObj = new URL(company.careers);
          const guessedWeb = `${urlObj.protocol}//${urlObj.hostname}`;
          if (await verifyUrl(guessedWeb)) {
            company.website = guessedWeb;
            isWebOk = true;
            logMessage(state, `[Worker ${workerId}] Extracted homepage for "${company.name}" from careers URL: ${guessedWeb}`);
          }
        } catch (e) {}
      }

      if (isWebOk && isCareersOk) {
        results = {
          website: company.website,
          careers: company.careers,
          source: `Pre-populated URL (Verified: Web=Working, Careers=Working)`
        };
      } else if (isWebOk && !isCareersOk) {
        logMessage(state, `🔍 [Worker ${workerId}] Web working but careers page missing/dead for "${company.name}". Searching search engines...`);
        const searchResults = await scrapeCompany(company.name, state.delayMs, state.searchEngine || 'all', state.blacklistDomains || DEFAULT_BLACKLIST_DOMAINS);
        results = {
          website: company.website,
          careers: searchResults.careers !== 'N/A' ? searchResults.careers : 'N/A',
          source: `Pre-populated URL + Search Fallback`
        };
      } else if (!isWebOk && isCareersOk) {
        logMessage(state, `🔍 [Worker ${workerId}] Careers working but website missing/dead for "${company.name}". Searching search engines...`);
        const searchResults = await scrapeCompany(company.name, state.delayMs, state.searchEngine || 'all', state.blacklistDomains || DEFAULT_BLACKLIST_DOMAINS);
        results = {
          website: searchResults.website !== 'N/A' ? searchResults.website : 'N/A',
          careers: company.careers,
          source: `Pre-populated URL + Search Fallback`
        };
      } else {
        logMessage(state, `⚠️ [Worker ${workerId}] Pre-populated URLs for "${company.name}" failed verification. Falling back to search engines.`);
        results = await scrapeCompany(company.name, state.delayMs, state.searchEngine || 'all', state.blacklistDomains || DEFAULT_BLACKLIST_DOMAINS);
      }
    } else {
      results = await scrapeCompany(company.name, state.delayMs, state.searchEngine || 'all', state.blacklistDomains || DEFAULT_BLACKLIST_DOMAINS);
    }

    company.website = results.website;
    company.careers = results.careers;
    company.status = 'success';
    company.timestamp = new Date().toISOString();

    // Scan resolved website & careers pages and check online status simultaneously
    const [isWebScam, isCareersScam, isFinalWebOk, isFinalCareersOk] = await Promise.all([
      company.website && company.website !== 'N/A' ? checkForFeeScam(company.website, state.scamKeywords || DEFAULT_SCAM_KEYWORDS) : Promise.resolve(false),
      company.careers && company.careers !== 'N/A' ? checkForFeeScam(company.careers, state.scamKeywords || DEFAULT_SCAM_KEYWORDS) : Promise.resolve(false),
      company.website && company.website !== 'N/A' ? verifyUrl(company.website) : Promise.resolve(false),
      company.careers && company.careers !== 'N/A' ? verifyUrl(company.careers) : Promise.resolve(false)
    ]);

    if (isWebScam || isCareersScam) {
      logMessage(state, `🚫 [Scam Alert] Flagged company "${company.name}" - Suspected fee-charging placement scam.`);
      company.isScam = true;
      company.status = 'failed';
      company.verified = false;
      company.isFake = true;
      company.error = 'Suspected Scam (Flagged for charging fees/deposits)';
      state.removedScamsCount = (state.removedScamsCount || 0) + 1;
      saveState(state);

      if (inMemoryState && inMemoryState.status === 'running') {
        const timer = setTimeout(() => runWorker(workerId), state.delayMs);
        activeTimers.push(timer);
      }
      return;
    }

    if (isFinalWebOk || isFinalCareersOk) {
      company.verified = true;
      company.isFake = false;
      company.error = undefined;
      logMessage(state, `[Worker ${workerId}] ✅ Found via ${results.source}: "${company.name}" => Web: ${company.website} | Careers: ${company.careers} (Verified)`);
    } else if (company.website !== 'N/A' || company.careers !== 'N/A') {
      // URLs were found but the site is slow / temporarily offline — still a success, just unverified
      company.verified = false;
      company.isFake = false;
      company.status = 'success';
      company.error = undefined;
      logMessage(state, `[Worker ${workerId}] ⚠️ Found via ${results.source}: "${company.name}" => Web: ${company.website} | Careers: ${company.careers} (URL found, site may be slow)`);
    } else {
      // Truly no URL found at all
      company.verified = false;
      company.isFake = true;
      company.status = 'failed';
      company.error = 'No website found — company may not have an online presence';
      logMessage(state, `[Worker ${workerId}] ❌ No URL found for "${company.name}"`);
    }
  } catch (error: any) {
    console.error(`Worker ${workerId} error for ${company.name}:`, error);
    
    company.website = 'N/A';
    company.careers = 'N/A';
    company.status = 'failed';
    company.error = error.message || 'Unknown error';
    company.timestamp = new Date().toISOString();
    logMessage(state, `❌ [Worker ${workerId}] Failed "${company.name}": ${company.error}`);
  }

  saveState(state);

  // Trigger next company immediately (worker-level delay is set in startScraper)
  if (inMemoryState && inMemoryState.status === 'running') {
    const timer = setTimeout(() => runWorker(workerId), state.delayMs);
    activeTimers.push(timer);
  }
}

// Controller functions
export function startScraper(delayMs: number = 500, concurrency: number = 5) {
  const state = loadState();
  if (state.status === 'running') return state;

  state.status = 'running';
  state.delayMs = delayMs;
  state.concurrency = concurrency;
  
  if (!state.startTime) {
    state.startTime = new Date().toISOString();
  }
  state.endTime = null;
  logMessage(state, `Scraper started. Running ${concurrency} workers with ${delayMs}ms delay.`);
  saveState(state);

  // Clear previous timers
  activeTimers.forEach(clearTimeout);
  activeTimers = [];

  // Launch parallel workers with minimal stagger to avoid thundering herd
  for (let i = 1; i <= concurrency; i++) {
    const startTimer = setTimeout(() => runWorker(i), i * 50);
    activeTimers.push(startTimer);
  }

  return state;
}

export function pauseScraper() {
  const state = loadState();
  if (state.status !== 'running') return state;

  state.status = 'paused';
  logMessage(state, 'Scraper paused by user.');
  saveState(state);

  activeTimers.forEach(clearTimeout);
  activeTimers = [];

  return state;
}

export function stopScraper() {
  const state = loadState();
  state.status = 'stopped';
  state.endTime = new Date().toISOString();
  logMessage(state, 'Scraper stopped by user.');
  saveState(state);

  activeTimers.forEach(clearTimeout);
  activeTimers = [];

  return state;
}

export function resetScraper(companiesList: (string | Partial<ScrapedCompany>)[]) {
  activeTimers.forEach(clearTimeout);
  activeTimers = [];

  const state = getInitialState(companiesList);
  saveState(state);
  return state;
}

// Re-process all failed/offline companies — resets them to pending without losing successes
export function rescrapeAll(delayMs: number = 500, concurrency: number = 5) {
  activeTimers.forEach(clearTimeout);
  activeTimers = [];

  const state = loadState();

  // Reset failed/offline companies back to pending so they get re-processed
  let resetCount = 0;
  state.companies.forEach(c => {
    if (c.status === 'failed' || (c.status === 'success' && c.isFake)) {
      c.status = 'pending';
      c.website = 'N/A';
      c.careers = 'N/A';
      c.error = undefined;
      c.verified = false;
      c.isFake = false;
      c.isScam = false;
      resetCount++;
    }
  });

  // Rebuild currentIndex to point at the first pending company
  state.currentIndex = state.companies.findIndex(c => c.status === 'pending');
  if (state.currentIndex === -1) state.currentIndex = state.companies.length;

  state.status = 'running';
  state.delayMs = delayMs;
  state.concurrency = concurrency;
  state.startTime = new Date().toISOString();
  state.endTime = null;
  logMessage(state, `🔄 Re-scraping ${resetCount} failed companies with ${concurrency} workers @ ${delayMs}ms delay.`);
  saveState(state);

  // Launch workers
  for (let i = 1; i <= concurrency; i++) {
    const startTimer = setTimeout(() => runWorker(i), i * 50);
    activeTimers.push(startTimer);
  }

  return state;
}

export function updateSingleCompany(name: string, website: string, careers: string): ScrapeState {
  const state = loadState();
  const company = state.companies.find(c => c.name === name);
  if (company) {
    company.website = website.trim();
    company.careers = careers.trim();
    
    const hasUrls = (company.website && company.website !== 'N/A') || (company.careers && company.careers !== 'N/A');
    company.status = hasUrls ? 'success' : 'pending';
    company.verified = hasUrls ? true : false;
    company.isFake = hasUrls ? false : undefined;
    
    company.timestamp = new Date().toISOString();
    logMessage(state, `✏️ Manually updated company "${name}" => Web: ${company.website} | Careers: ${company.careers}`);
    saveState(state);
  }
  return state;
}

export async function verifySingleCompany(name: string, website?: string, careers?: string): Promise<ScrapeState> {
  const state = loadState();
  const company = state.companies.find(c => c.name === name);
  if (company) {
    if (website !== undefined) company.website = website.trim();
    if (careers !== undefined) company.careers = careers.trim();
company.status = 'pending';
    company.error = undefined;
    company.isScam = false; // Reset before checking
    saveState(state);

    logMessage(state, `🔍 Verifying URLs for "${name}": Web: ${company.website || 'N/A'} | Careers: ${company.careers || 'N/A'}`);
    
    try {
      let [isWebOk, isCareersOk] = await Promise.all([
        company.website && company.website !== 'N/A' ? verifyUrl(company.website) : Promise.resolve(false),
        company.careers && company.careers !== 'N/A' ? verifyUrl(company.careers) : Promise.resolve(false)
      ]);

      // Guess careers in parallel on verified domain
      if (isWebOk && !isCareersOk && company.website) {
        const commonPaths = ['/careers', '/jobs', '/careers-page', '/join-us', '/work-with-us'];
        const paths = commonPaths.map(p => company.website.endsWith('/') ? `${company.website.slice(0, -1)}${p}` : `${company.website}${p}`);
        const pathResults = await Promise.all(paths.map(async (path) => {
          const ok = await verifyUrl(path);
          return ok ? path : null;
        }));
        const workingPath = pathResults.find(p => p !== null);
        if (workingPath) {
          company.careers = workingPath;
          isCareersOk = true;
          logMessage(state, `[Verify] Found careers page for "${name}" under domain: ${workingPath}`);
        }
      }

      // Extract base domain from working careers URL
      if (!isWebOk && isCareersOk && company.careers) {
        try {
          const urlObj = new URL(company.careers);
          const guessedWeb = `${urlObj.protocol}//${urlObj.hostname}`;
          if (await verifyUrl(guessedWeb)) {
            company.website = guessedWeb;
            isWebOk = true;
            logMessage(state, `[Verify] Extracted homepage for "${name}" from careers URL: ${guessedWeb}`);
          }
        } catch (e) {}
      }

      // Perform scam scanning in parallel
      const [isWebScam, isCareersScam] = await Promise.all([
        company.website && company.website !== 'N/A' ? checkForFeeScam(company.website, state.scamKeywords || DEFAULT_SCAM_KEYWORDS) : Promise.resolve(false),
        company.careers && company.careers !== 'N/A' ? checkForFeeScam(company.careers, state.scamKeywords || DEFAULT_SCAM_KEYWORDS) : Promise.resolve(false)
      ]);

      if (isWebScam || isCareersScam) {
        logMessage(state, `🚫 [Scam Alert] Flagged company "${name}" - Suspected fee-charging placement scam.`);
        company.isScam = true;
        company.status = 'failed';
        company.verified = false;
        company.isFake = true;
        company.error = 'Suspected Scam (Flagged for charging fees/deposits)';
        state.removedScamsCount = (state.removedScamsCount || 0) + 1;
        saveState(state);
        return state;
      }

      // Perform check for verification status to set verified/isFake badges in parallel
      const [isFinalWebOk, isFinalCareersOk] = await Promise.all([
        company.website && company.website !== 'N/A' ? verifyUrl(company.website) : Promise.resolve(false),
        company.careers && company.careers !== 'N/A' ? verifyUrl(company.careers) : Promise.resolve(false)
      ]);

      if (isFinalWebOk || isFinalCareersOk) {
        company.verified = true;
        company.isFake = false;
        company.status = 'success';
        company.error = undefined;
        logMessage(state, `✅ URL Verification success for "${name}": Web=${isFinalWebOk ? 'Working' : 'Offline'}, Careers=${isFinalCareersOk ? 'Working' : 'Offline'}`);
      } else {
        company.verified = false;
        company.isFake = true;
        company.status = 'failed';
        company.error = 'Offline / Fake: Domain did not respond / page offline';
        logMessage(state, `❌ URL Verification failed for "${name}". Marked as Offline/Fake.`);
      }
    } catch (err: any) {
      company.status = 'failed';
      company.error = err.message || 'Verification failed';
      logMessage(state, `❌ Verification failed for "${name}": ${company.error}`);
    }
    company.timestamp = new Date().toISOString();
    saveState(state);
  }
  return state;
}

export function deleteSingleCompany(name: string): ScrapeState {
  const state = loadState();
  const originalCount = state.companies.length;
  state.companies = state.companies.filter(c => c.name !== name);
  state.total = state.companies.length;
  if (state.currentIndex > state.total) {
    state.currentIndex = state.total;
  }
  if (state.companies.length < originalCount) {
    logMessage(state, `🗑️ Removed company "${name}" from directory list.`);
  }
  saveState(state);
  return state;
}

export function bulkDeleteCompanies(names: string[]): ScrapeState {
  const state = loadState();
  const originalCount = state.companies.length;
  state.companies = state.companies.filter(c => !names.includes(c.name));
  state.total = state.companies.length;
  if (state.currentIndex > state.total) {
    state.currentIndex = state.total;
  }
  logMessage(state, `🗑️ Bulk removed ${originalCount - state.companies.length} companies from directory.`);
  saveState(state);
  return state;
}

export async function bulkVerifyCompanies(names: string[]): Promise<ScrapeState> {
  let state = loadState();
  logMessage(state, `⚡ Starting bulk verification for ${names.length} entities...`);
  
  for (const name of names) {
    state = await verifySingleCompany(name);
  }
  
  logMessage(state, `✅ Bulk verification complete.`);
  return state;
}

export function wipeStorage(): ScrapeState {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
  inMemoryState = null;
  const newState = getInitialState();
  logMessage(newState, '🚨 Storage wiped. All persistent data has been cleared.');
  saveState(newState);
  return newState;
}

export function updateScraperSettings(
  searchEngine: 'all' | 'heuristics_first' | 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage' | 'guess',
  blacklistDomains: string[],
  scamKeywords: string[],
  delayMs: number,
  concurrency: number
): ScrapeState {
  const state = loadState();
  state.searchEngine = searchEngine;
  state.blacklistDomains = blacklistDomains;
  state.scamKeywords = scamKeywords;
  state.delayMs = delayMs;
  state.concurrency = concurrency;
  logMessage(state, '⚙️ Scraper settings updated.');
  saveState(state);
  return state;
}

export function clearScraperLogs(): ScrapeState {
  const state = loadState();
  state.logs = ['🗑️ Console history cleared.'];
  saveState(state);
  return state;
}

export function toggleCompanyJobTracking(name: string): ScrapeState {
  const state = loadState();
  const company = state.companies.find(c => c.name === name);
  if (company) {
    company.jobTracked = !company.jobTracked;
    logMessage(state, `🔔 Toggled job tracking for "${name}": ${company.jobTracked ? 'ACTIVE' : 'INACTIVE'}`);
    saveState(state);
  }
  return state;
}
