import { NextRequest, NextResponse } from 'next/server';
import pg from 'pg';

export async function GET(req: NextRequest) {
  try {
    if (!process.env.PG_CONN_STRING) {
      return NextResponse.json({ error: 'PostgreSQL connection string not set.' });
    }

    const pool = new pg.Pool({
      connectionString: process.env.PG_CONN_STRING,
      ssl: { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    try {
      // Get total count of jobs
      const countRes = await client.query('SELECT COUNT(*) FROM jobs_discovery');
      const totalCount = parseInt(countRes.rows[0].count);

      // Find duplicates by normalized title, company, and location
      const dupRes = await client.query(`
        SELECT 
          LOWER(REGEXP_REPLACE(a.company_name, '\\\\b(pvt|ltd|private|limited|inc|corp|co|company|india|technologies|solutions|software|systems)\\\\b', '', 'gi')) as norm_company,
          LOWER(REGEXP_REPLACE(REGEXP_REPLACE(a.job_title, '\\\\s*[\\\\(\\\\[][^\\\\]\\\\)]*[\\\\]\\\\]', '', 'g'), '[^a-z0-9]', '', 'g')) as norm_title,
          COALESCE(NULLIF(LOWER(REGEXP_REPLACE(a.city, '[^a-z]', '', 'g')), ''), NULLIF(LOWER(REGEXP_REPLACE(a.location, '[^a-z]', '', 'g')), ''), 'india') as norm_location,
          COUNT(*) as cnt,
          ARRAY_AGG(job_id) as ids,
          ARRAY_AGG(company_name) as original_companies,
          ARRAY_AGG(job_title) as original_titles,
          ARRAY_AGG(location) as locations,
          ARRAY_AGG(job_url) as urls
        FROM jobs_discovery a
        GROUP BY 1, 2, 3
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
        LIMIT 50
      `);

      return NextResponse.json({
        totalJobs: totalCount,
        duplicatesCount: dupRes.rowCount,
        duplicates: dupRes.rows.map(row => ({
          normalizedCompany: row.norm_company,
          normalizedTitle: row.norm_title,
          count: parseInt(row.cnt),
          ids: row.ids,
          companies: row.original_companies,
          titles: row.original_titles,
          locations: row.locations,
          urls: row.urls
        }))
      });
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
