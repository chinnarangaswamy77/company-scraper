import { NextRequest, NextResponse } from 'next/server';
import { 
  loadJobState, 
  runJobScraper, 
  clearScrapedJobs, 
  startJobScraperCron,
  saveJobState,
  extractJobsFromUrl,
  generateJobFingerprint
} from '@/lib/job-scraper';
import { 
  loadLocalHourlyReports, 
  dbLoadJobs, 
  dbLoadHourlyReports, 
  isPgAvailable,
  initDatabase,
  dbUpsertJob,
  dbUpsertAiJob
} from '@/lib/db';
import { toggleCompanyJobTracking } from '@/lib/scraper';
import { isAiEnabled } from '@/lib/ai/model-registry';
import { aiExtractJob, batchAiEnrich } from '@/lib/ai/job-extractor';

// GET: Retrieves current job scraping state and historical hourly reports
export async function GET(req: NextRequest) {
  try {
    // Start hourly background sync if not already active
    startJobScraperCron();
    
    // Initialize & clean database duplicates on dashboard load
    if (isPgAvailable) {
      await initDatabase().catch(err => console.error('DB init failed on GET:', err.message));
    }
    
    const state = loadJobState();
    let jobs = state.jobs;
    let reports = [];

    if (isPgAvailable) {
      jobs = await dbLoadJobs();
      reports = await dbLoadHourlyReports();
    } else {
      reports = loadLocalHourlyReports();
    }

    // Default queue stats if Redis is down/offline
    let queueStats: any = {
      discovery: { waiting: 0, active: 0, delayed: 0 },
      crawl: { waiting: 0, active: 0, delayed: 0 },
      enrichment: { waiting: 0, active: 0, delayed: 0 },
      dedupe: { waiting: 0, active: 0, delayed: 0 },
      activeWorkers: 0,
      hpaReplicas: 5
    };

    try {
      const { discoveryQueue, crawlQueue, aiEnrichmentQueue, dedupeQueue } = require('@/lib/workers/worker-orchestrator');
      if (discoveryQueue && crawlQueue && aiEnrichmentQueue && dedupeQueue) {
        queueStats.discovery = await discoveryQueue.getJobCounts('waiting', 'active', 'delayed');
        queueStats.crawl = await crawlQueue.getJobCounts('waiting', 'active', 'delayed');
        queueStats.enrichment = await aiEnrichmentQueue.getJobCounts('waiting', 'active', 'delayed');
        queueStats.dedupe = await dedupeQueue.getJobCounts('waiting', 'active', 'delayed');
        
        // Sum up total waiting/active
        const waitingCount = 
          (queueStats.discovery.waiting || 0) + 
          (queueStats.crawl.waiting || 0) + 
          (queueStats.enrichment.waiting || 0) + 
          (queueStats.dedupe.waiting || 0);
          
        const activeCount = 
          (queueStats.discovery.active || 0) + 
          (queueStats.crawl.active || 0) + 
          (queueStats.enrichment.active || 0) + 
          (queueStats.dedupe.active || 0);

        queueStats.activeWorkers = Math.max(5, activeCount);
        
        // Dynamic simulated HPA replica scaling based on waiting count
        queueStats.hpaReplicas = Math.min(100, Math.max(5, Math.floor(waitingCount / 10) + 5));
      }
    } catch (e) {
      // Redis offline/error, ignore
    }

    return NextResponse.json({
      ...state,
      jobs,
      reports,
      queueStats
    });
  } catch (error: any) {
    console.error('API Error in GET /api/jobs:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve jobs database.' },
      { status: 500 }
    );
  }
}

// POST: Handles trigger_scrape, clear, and toggle_tracking requests
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, companyName } = body;

    if (!action || typeof action !== 'string') {
      return NextResponse.json({ error: 'Action parameter is required.' }, { status: 400 });
    }

    let state = loadJobState();

    switch (action.toLowerCase()) {
      case 'trigger_scrape':
        state.logs = ['🚀 Initiating live India job discovery sequence...'];
        state.status = 'running';
        saveJobState(state);

        // Run discovery process asynchronously to prevent gateway timeouts
        runJobScraper().catch(err => {
          console.error('Manual background job discovery error:', err.message);
        });
        break;

      case 'clear':
        state = await clearScrapedJobs();
        break;

      case 'toggle_tracking':
        if (!companyName || typeof companyName !== 'string') {
          return NextResponse.json({ error: 'companyName is required for toggle_tracking.' }, { status: 400 });
        }
        toggleCompanyJobTracking(companyName);
        break;

      case 'set_interval':
        if (typeof body.interval !== 'number' || body.interval <= 0) {
          return NextResponse.json({ error: 'interval must be a positive number.' }, { status: 400 });
        }
        startJobScraperCron(body.interval);
        state = loadJobState();
        break;

      case 'import_jobs':
        if (!Array.isArray(body.jobs)) {
          return NextResponse.json({ error: 'jobs array is required for import_jobs.' }, { status: 400 });
        }
        if (isPgAvailable) {
          for (const job of body.jobs) {
            if (job.ai_extracted) {
              await dbUpsertAiJob(job);
            } else {
              await dbUpsertJob(job);
            }
          }
        } else {
          const localState = loadJobState();
          const existingIds = new Set(localState.jobs.map(j => j.job_id));
          for (const job of body.jobs) {
            if (!existingIds.has(job.job_id)) {
              localState.jobs.push(job);
            } else {
              // replace existing with updated / enriched info
              const idx = localState.jobs.findIndex(j => j.job_id === job.job_id);
              if (idx !== -1) {
                localState.jobs[idx] = { ...localState.jobs[idx], ...job };
              }
            }
          }
          saveJobState(localState);
        }
        break;

      case 'scrape_url':
        if (!body.url || typeof body.url !== 'string') {
          return NextResponse.json({ error: 'url parameter is required for scrape_url.' }, { status: 400 });
        }
        try {
          const extracted = await extractJobsFromUrl(body.url);
          return NextResponse.json({
            success: true,
            count: extracted.length,
            jobs: extracted
          });
        } catch (e: any) {
          return NextResponse.json({ error: e.message || 'Failed to extract jobs from URL.' }, { status: 500 });
        }

      case 'ai_extract':
        if (!body.url || typeof body.url !== 'string') {
          return NextResponse.json({ error: 'url parameter is required for ai_extract.' }, { status: 400 });
        }
        if (!isAiEnabled()) {
          return NextResponse.json({ error: 'AI is not enabled (missing OpenRouter key).' }, { status: 400 });
        }
        try {
          const extracted = await aiExtractJob(body.url);
          if (!extracted.success || !extracted.scrapedJobFields) {
            return NextResponse.json({ error: extracted.error || 'AI failed to extract structured job details.' }, { status: 500 });
          }

          const company = (extracted.scrapedJobFields.company_name as string) || 'Live Discovered Co';
          const title = (extracted.scrapedJobFields.job_title as string) || 'Job Opening';
          const location = (extracted.scrapedJobFields.location as string) || 'India';
          const fingerprint = generateJobFingerprint({
            job_url: body.url,
            company_name: company,
            job_title: title,
            location: location
          });

          const workMode = (extracted.scrapedJobFields.work_mode as string) || 'onsite';

          const fullJob = {
            ...extracted.scrapedJobFields,
            job_id: fingerprint,
            job_fingerprint: fingerprint,
            first_seen_timestamp: new Date().toISOString(),
            last_seen_timestamp: new Date().toISOString(),
            status: 'OPEN',
            source_name: extracted.job?.source_type === 'ats' ? 'ATS Board' : 'Company Careers',
            
            // Compatibility fields
            id: fingerprint,
            title: title,
            companyName: company,
            url: body.url,
            scrapedAt: new Date().toISOString(),
            postedDate: extracted.scrapedJobFields.posted_date || new Date().toISOString(),
            remote: workMode === 'remote',
            salary: extracted.scrapedJobFields.salary_range || '',
            salary_range: extracted.scrapedJobFields.salary_range || ''
          };

          return NextResponse.json({
            success: true,
            count: 1,
            jobs: [fullJob]
          });
        } catch (e: any) {
          return NextResponse.json({ error: e.message || 'AI extraction failed.' }, { status: 500 });
        }

      case 'ai_rescan':
        if (!body.url || typeof body.url !== 'string') {
          return NextResponse.json({ error: 'url parameter is required for ai_rescan.' }, { status: 400 });
        }
        if (!isAiEnabled()) {
          return NextResponse.json({ error: 'AI is not enabled (missing OpenRouter key).' }, { status: 400 });
        }
        try {
          const extracted = await aiExtractJob(body.url);
          if (!extracted.success || !extracted.scrapedJobFields) {
            return NextResponse.json({ error: extracted.error || 'AI rescan failed to extract job details.' }, { status: 500 });
          }

          const company = (extracted.scrapedJobFields.company_name as string) || 'Live Discovered Co';
          const title = (extracted.scrapedJobFields.job_title as string) || 'Job Opening';
          const location = (extracted.scrapedJobFields.location as string) || 'India';
          const fingerprint = generateJobFingerprint({
            job_url: body.url,
            company_name: company,
            job_title: title,
            location: location
          });

          const workMode = (extracted.scrapedJobFields.work_mode as string) || 'onsite';

          const fullJob = {
            ...extracted.scrapedJobFields,
            job_id: fingerprint,
            job_fingerprint: fingerprint,
            first_seen_timestamp: new Date().toISOString(),
            last_seen_timestamp: new Date().toISOString(),
            status: 'OPEN',
            source_name: extracted.job?.source_type === 'ats' ? 'ATS Board' : 'Company Careers',
            
            // Compatibility fields
            id: fingerprint,
            title: title,
            companyName: company,
            url: body.url,
            scrapedAt: new Date().toISOString(),
            postedDate: extracted.scrapedJobFields.posted_date || new Date().toISOString(),
            remote: workMode === 'remote',
            salary: extracted.scrapedJobFields.salary_range || '',
            salary_range: extracted.scrapedJobFields.salary_range || ''
          };

          if (isPgAvailable) {
            await dbUpsertAiJob(fullJob as any);
          } else {
            const localState = loadJobState();
            const idx = localState.jobs.findIndex(j => j.job_id === fingerprint);
            if (idx !== -1) {
              localState.jobs[idx] = fullJob as any;
            } else {
              localState.jobs.push(fullJob as any);
            }
            saveJobState(localState);
          }

          return NextResponse.json({
            success: true,
            count: 1,
            jobs: [fullJob]
          });
        } catch (e: any) {
          return NextResponse.json({ error: e.message || 'AI rescan failed.' }, { status: 500 });
        }

      case 'ai_enrich_all':
        if (!isAiEnabled()) {
          return NextResponse.json({ error: 'AI is not enabled (missing OpenRouter key).' }, { status: 400 });
        }
        try {
          const allJobs = isPgAvailable ? await dbLoadJobs() : loadJobState().jobs;
          const toEnrich = allJobs.filter(j => !j.ai_extracted);
          if (toEnrich.length === 0) {
            return NextResponse.json({ success: true, message: 'All jobs are already enriched.' });
          }

          // Background enrich process
          const enrichProcess = async () => {
            console.log(`[AI Enrichment] Starting batch enrichment of ${toEnrich.length} jobs...`);
            await batchAiEnrich(toEnrich as any, async (jobId, result) => {
              if (result.success && result.scrapedJobFields) {
                const existing = allJobs.find(j => j.job_id === jobId);
                if (existing) {
                  const updatedJob = {
                    ...existing,
                    ...result.scrapedJobFields,
                    ai_extracted: true
                  };
                  if (isPgAvailable) {
                    await dbUpsertAiJob(updatedJob as any);
                  } else {
                    const localState = loadJobState();
                    const idx = localState.jobs.findIndex(j => j.job_id === jobId);
                    if (idx !== -1) {
                      localState.jobs[idx] = updatedJob as any;
                      saveJobState(localState);
                    }
                  }
                }
              }
            });
            console.log(`[AI Enrichment] Completed batch enrichment.`);
          };

          enrichProcess().catch(err => {
            console.error('Background AI enrichment failed:', err);
          });

          return NextResponse.json({
            success: true,
            message: `Started AI enrichment of ${toEnrich.length} jobs in background.`
          });
        } catch (e: any) {
          return NextResponse.json({ error: e.message || 'Failed to trigger batch enrichment.' }, { status: 500 });
        }

      default:
        return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
    }

    let jobs = state.jobs;
    let reports = [];

    if (isPgAvailable) {
      jobs = await dbLoadJobs();
      reports = await dbLoadHourlyReports();
    } else {
      reports = loadLocalHourlyReports();
    }

    return NextResponse.json({
      ...state,
      jobs,
      reports
    });
  } catch (error: any) {
    console.error('API Error in POST /api/jobs:', error);
    return NextResponse.json(
      { error: 'An error occurred while executing the jobs controller action.' },
      { status: 500 }
    );
  }
}
