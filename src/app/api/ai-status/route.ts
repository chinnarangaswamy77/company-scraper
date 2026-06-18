import { NextRequest, NextResponse } from 'next/server';
import { getModelStatuses } from '@/lib/ai/openrouter-client';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  try {
    const statuses = getModelStatuses();
    return NextResponse.json({ statuses });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
