import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { chromium } from 'playwright';
import {
  isPgAvailable,
  pool,
  dbUpsertAiJob,
  ScrapedJob
} from '../db';
import { loadJobState, saveJobState } from '../job-scraper';
import { optimizedAiExtract } from '../ai/job-extractor';
import { findDuplicateSemanticJob } from '../ai/deduplicator';

// Create a safe Redis connection that doesn't crash the server if Redis is down
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
console.log(`🔌 Initializing Redis connection at ${REDIS_URL}`);

let redisConnection: IORedis | null = null;
let isRedisAvailable = false;

// Queue definitions (lazy-initialized or exported if Redis is available)
export let discoveryQueue: Queue | null = null;
export let crawlQueue: Queue | null = null;
export let aiEnrichmentQueue: Queue | null = null;
export let dedupeQueue: Queue | null = null;

export let crawlWorker: Worker | null = null;
export let aiEnrichmentWorker: Worker | null = null;
export let dedupeWorker: Worker | null = null;

try {
  redisConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: 2000,
    retryStrategy(times) {
      // Stop retrying after 1 failed attempt to disable background noise
      if (times > 1) {
        console.log('🔌 Redis is offline. Operating in standalone fallback mode (skipping distributed queues).');
        isRedisAvailable = false;
        return null; // stop retrying
      }
      return 500; // retry once after 500ms
    }
  });

  redisConnection.on('error', (err) => {
    // Only log if connection was active and then lost at runtime
    if (isRedisAvailable) {
      console.warn('⚠️ Redis Connection Lost:', err.message);
      isRedisAvailable = false;
    }
  });

  redisConnection.on('connect', () => {
    console.log('✅ Connected to Redis successfully. Initializing queues and workers.');
    isRedisAvailable = true;

    if (!discoveryQueue && redisConnection) {
      discoveryQueue = new Queue('DiscoveryQueue', { connection: redisConnection as any });
      crawlQueue = new Queue('CrawlQueue', { connection: redisConnection as any });
      aiEnrichmentQueue = new Queue('AiEnrichmentQueue', { connection: redisConnection as any });
      dedupeQueue = new Queue('DedupeQueue', { connection: redisConnection as any });
    }

    if (!crawlWorker && redisConnection) {
      // 1. Playwright Crawl Worker
      crawlWorker = new Worker(
        'CrawlQueue',
        async (job: Job) => {
          const { url, rules } = job.data;
          console.log(`[Crawler Worker] Starting crawl for URL: ${url}`);

          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
          });
          const page = await context.newPage();

          try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            // Support infinite scroll if requested
            if (rules?.infiniteScroll) {
              await page.evaluate(async () => {
                await new Promise<void>((resolve) => {
                  let totalHeight = 0;
                  const distance = 100;
                  const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight || totalHeight > 5000) {
                      clearInterval(timer);
                      resolve();
                    }
                  }, 100);
                });
              });
            }

            const htmlContent = await page.content();
            console.log(`[Crawler Worker] Crawled HTML size: ${htmlContent.length} bytes`);

            // Enqueue for AI enrichment
            if (aiEnrichmentQueue) {
              await aiEnrichmentQueue.add(`enrich-${Date.now()}`, {
                url,
                html: htmlContent
              });
            } else {
              console.warn('⚠️ AI Enrichment Queue is not available, skipping enrichment');
            }

            return { success: true, url };
          } catch (err: any) {
            console.error(`[Crawler Worker] Error crawling ${url}:`, err.message);
            throw err;
          } finally {
            await browser.close();
          }
        },
        { connection: redisConnection as any, concurrency: 5 }
      );

      // 2. AI Enrichment Worker
      aiEnrichmentWorker = new Worker(
        'AiEnrichmentQueue',
        async (job: Job) => {
          const { url, html } = job.data;
          console.log(`[AI Enrichment Worker] Ingesting HTML content from ${url}`);

          try {
            const result = await optimizedAiExtract(url, html);
            if (result.success && result.data) {
              console.log(`[AI Enrichment Worker] Successfully extracted job: "${result.data.job_title}"`);
              
              // Add to deduplication queue
              if (dedupeQueue) {
                await dedupeQueue.add(`dedupe-${Date.now()}`, {
                  jobData: {
                    ...result.data,
                    source_url: url,
                    job_url: url
                  }
                });
              } else {
                console.warn('⚠️ Dedupe Queue not available. Writing directly to DB/File.');
                await processJobSave(result.data);
              }
            } else {
              console.warn(`[AI Enrichment Worker] AI Extraction did not return valid data: ${result.reason || 'Unknown error'}`);
            }
          } catch (err: any) {
            console.error(`[AI Enrichment Worker] Error during AI extraction:`, err.message);
            throw err;
          }
        },
        { connection: redisConnection as any, concurrency: 3 }
      );

      // 3. Deduplication and Database Writer Worker
      dedupeWorker = new Worker(
        'DedupeQueue',
        async (job: Job) => {
          const { jobData } = job.data;
          console.log(`[Dedupe Worker] Processing duplicate checks for: "${jobData.job_title}" at "${jobData.company_name}"`);

          try {
            await processJobSave(jobData);
          } catch (err: any) {
            console.error(`[Dedupe Worker] Error processing save:`, err.message);
            throw err;
          }
        },
        { connection: redisConnection as any, concurrency: 5 }
      );
    }
  });
} catch (err: any) {
  console.warn('⚠️ Failed to initialize Redis connection:', err.message);
}

/**
 * Common logic to check duplicate, scoring, and saving a scraped job
 */
async function processJobSave(jobData: any) {
  // Construct a standard ScrapedJob object
  const job_id = jobData.job_id || `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const scrapedJob: ScrapedJob = {
    job_id,
    company_name: jobData.company_name || 'Unknown',
    company_website: jobData.company_website || '',
    career_page_url: jobData.career_page_url || '',
    job_title: jobData.job_title || 'Unknown Role',
    job_url: jobData.job_url || '',
    location: jobData.location || 'India',
    city: jobData.city || '',
    state: jobData.state || '',
    country: jobData.country || 'India',
    work_mode: jobData.work_mode || 'onsite',
    employment_type: jobData.employment_type || 'full-time',
    experience_required: jobData.experience_required || '',
    skills: jobData.skills || [],
    department: jobData.department || '',
    posted_date: jobData.posted_date || new Date().toISOString(),
    application_deadline: jobData.application_deadline || '',
    status: 'OPEN',
    source_type: 'OFFICIAL',
    source_name: jobData.source_name || 'AI Crawler',
    first_seen_timestamp: new Date().toISOString(),
    last_seen_timestamp: new Date().toISOString(),
    description: jobData.description || '',
    apply_url: jobData.apply_url || jobData.job_url || '',
    ai_confidence: jobData.ai_confidence || 0.9,
    ai_model_used: jobData.ai_model_used || 'openai/gpt-4o-mini',
    ai_extracted: true,
    review_needed: (jobData.ai_confidence || 0.9) < 0.75,
    match_score: jobData.match_score || 70,
    freshness_score: jobData.freshness_score || 80,
    composite_score: jobData.composite_score || 75,
    tags: jobData.tags || [],
    salary_range: jobData.salary_range || '',
    language: jobData.language || 'en',
    skill_matches: jobData.skill_matches || [],
    skill_gaps: jobData.skill_gaps || [],
    match_explanation: jobData.match_explanation || ''
  };

  // Perform duplicate checking
  let isDuplicate = false;
  let existingJobId: string | null = null;

  if (isPgAvailable && pool) {
    try {
      // 1. Try vector semantic checking if embedding exists, otherwise run database heuristic checks
      const titleClean = scrapedJob.job_title.toLowerCase().replace(/\s+/g, '');
      const companyClean = scrapedJob.company_name.toLowerCase().replace(/\s+/g, '');
      const checkResult = await pool.query(
        `SELECT job_id FROM jobs_discovery 
         WHERE status = 'OPEN' 
           AND LOWER(REPLACE(company_name, ' ', '')) = $1 
           AND LOWER(REPLACE(job_title, ' ', '')) = $2`,
        [companyClean, titleClean]
      );
      if (checkResult.rows.length > 0) {
        isDuplicate = true;
        existingJobId = checkResult.rows[0].job_id;
      }
    } catch (dbErr: any) {
      console.warn('⚠️ DB Duplicate checking failed:', dbErr.message);
    }
  } else {
    // Local file fallback checking
    const state = loadJobState();
    const cleanTitle = scrapedJob.job_title.toLowerCase().replace(/\s+/g, '');
    const cleanCompany = scrapedJob.company_name.toLowerCase().replace(/\s+/g, '');
    const found = state.jobs.find(
      (j) =>
        j.status === 'OPEN' &&
        j.job_title.toLowerCase().replace(/\s+/g, '') === cleanTitle &&
        j.company_name.toLowerCase().replace(/\s+/g, '') === cleanCompany
    );
    if (found) {
      isDuplicate = true;
      existingJobId = found.job_id;
    }
  }

  if (isDuplicate) {
    console.log(`[Deduplicator] Skipped duplicate job opening: "${scrapedJob.job_title}" at "${scrapedJob.company_name}" (existing job ID: ${existingJobId})`);
    return;
  }

  // Save the job
  if (isPgAvailable && pool) {
    await dbUpsertAiJob(scrapedJob);
    console.log(`[Database] Saved job "${scrapedJob.job_title}" to jobs_discovery table.`);
  } else {
    const state = loadJobState();
    state.jobs.push(scrapedJob);
    saveJobState(state);
    console.log(`[File System] Saved job "${scrapedJob.job_title}" to local jobs_data.json.`);
  }
}

// Log startup if running workers directly
if (require.main === module) {
  console.log('🚀 Crawler worker cluster running, waiting for Redis connection...');
}
