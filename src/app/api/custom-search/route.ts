import { NextRequest, NextResponse } from 'next/server';
import { runCustomJobSearch } from '@/lib/job-scraper';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, engines, indiaOnly } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query parameter is required.' }, { status: 400 });
    }

    const parsedEngines = Array.isArray(engines) ? engines : ['ddg', 'yahoo', 'bing', 'brave'];
    const isIndiaOnly = typeof indiaOnly === 'boolean' ? indiaOnly : true;

    const results = await runCustomJobSearch(query, parsedEngines, isIndiaOnly);

    return NextResponse.json({
      success: true,
      query,
      count: results.length,
      jobs: results
    });
  } catch (error: any) {
    console.error('API Error in POST /api/custom-search:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred during search execution.' },
      { status: 500 }
    );
  }
}
