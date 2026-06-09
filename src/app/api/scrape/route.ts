import { NextRequest, NextResponse } from 'next/server';
import { 
  loadState, 
  startScraper, 
  pauseScraper, 
  stopScraper, 
  resetScraper,
  rescrapeAll,
  updateSingleCompany,
  verifySingleCompany,
  deleteSingleCompany,
  bulkDeleteCompanies,
  bulkVerifyCompanies,
  wipeStorage,
  updateScraperSettings,
  clearScraperLogs,
  ScrapeState 
} from '@/lib/scraper';
import { DEFAULT_COMPANIES } from '@/lib/companies-list';

// GET handler to check current scraping status
export async function GET() {
  try {
    const state = loadState(DEFAULT_COMPANIES);
    return NextResponse.json(state);
  } catch (error) {
    console.error('API Error in GET /api/scrape:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve scrape status.' },
      { status: 500 }
    );
  }
}

// POST handler to trigger controller commands (start, pause, stop, reset)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, delayMs, concurrency, companies, name, website, careers } = body;

    if (!action || typeof action !== 'string') {
      return NextResponse.json({ error: 'Action parameter is required' }, { status: 400 });
    }

    let state: ScrapeState;

    switch (action.toLowerCase()) {
      case 'start':
        const delay = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 500;
        const threads = typeof concurrency === 'number' && concurrency >= 1 && concurrency <= 30 ? concurrency : 5;
        state = startScraper(delay, threads);
        break;

      case 'pause':
        state = pauseScraper();
        break;

      case 'stop':
        state = stopScraper();
        break;

      case 'reset':
        // If custom companies are provided, reset with those, otherwise use default list
        const resetList = Array.isArray(companies) && companies.length > 0 
          ? companies.filter(c => {
              if (typeof c === 'string') return c.trim().length > 0;
              if (c && typeof c === 'object') return typeof c.name === 'string' && c.name.trim().length > 0;
              return false;
            })
          : DEFAULT_COMPANIES;
        state = resetScraper(resetList);
        break;

      case 'rescrape':
        // Re-process all failed companies without losing successes
        const rescrapeDelay = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 500;
        const rescrapeThreads = typeof concurrency === 'number' && concurrency >= 1 && concurrency <= 30 ? concurrency : 5;
        state = rescrapeAll(rescrapeDelay, rescrapeThreads);
        break;

      case 'update_single':
        if (!name || typeof name !== 'string') {
          return NextResponse.json({ error: 'Name parameter is required for update_single' }, { status: 400 });
        }
        state = updateSingleCompany(name, website || '', careers || '');
        break;

      case 'verify_single':
        if (!name || typeof name !== 'string') {
          return NextResponse.json({ error: 'Name parameter is required for verify_single' }, { status: 400 });
        }
        state = await verifySingleCompany(name, website || '', careers || '');
        break;

      case 'delete_single':
        if (!name || typeof name !== 'string') {
          return NextResponse.json({ error: 'Name parameter is required for delete_single' }, { status: 400 });
        }
        state = deleteSingleCompany(name);
        break;

      case 'bulk_delete':
        if (!Array.isArray(body.names)) {
          return NextResponse.json({ error: 'Names array is required for bulk_delete' }, { status: 400 });
        }
        state = bulkDeleteCompanies(body.names);
        break;

      case 'bulk_verify':
        if (!Array.isArray(body.names)) {
          return NextResponse.json({ error: 'Names array is required for bulk_verify' }, { status: 400 });
        }
        state = await bulkVerifyCompanies(body.names);
        break;

      case 'wipe_storage':
        state = wipeStorage();
        break;

      case 'update_settings':
        const searchEng = body.searchEngine || 'all';
        const blDomains = Array.isArray(body.blacklistDomains) ? body.blacklistDomains : [];
        const scKeywords = Array.isArray(body.scamKeywords) ? body.scamKeywords : [];
        const delayMsVal = typeof body.delayMs === 'number' ? body.delayMs : 500;
        const concurrencyVal = typeof body.concurrency === 'number' ? body.concurrency : 5;
        state = updateScraperSettings(searchEng, blDomains, scKeywords, delayMsVal, concurrencyVal);
        break;

      case 'clear_logs':
        state = clearScraperLogs();
        break;

      default:
        return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
    }

    return NextResponse.json(state);
  } catch (error) {
    console.error('API Error in POST /api/scrape:', error);
    return NextResponse.json(
      { error: 'An error occurred while executing the scrape controller action.' },
      { status: 500 }
    );
  }
}
