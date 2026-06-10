import { NextRequest, NextResponse } from 'next/server';
import { 
  loadJobState, 
  runJobScraper, 
  clearScrapedJobs, 
  startJobScraperCron,
  saveJobState
} from '@/lib/job-scraper';
import { 
  loadLocalHourlyReports, 
  dbLoadJobs, 
  dbLoadHourlyReports, 
  isPgAvailable,
  initDatabase
} from '@/lib/db';
import { toggleCompanyJobTracking } from '@/lib/scraper';

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

    return NextResponse.json({
      ...state,
      jobs,
      reports
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
        state.jobs = [];
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
