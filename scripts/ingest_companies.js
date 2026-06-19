const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Paths
const CAREER_JSON_PATH = '/Users/ravipatichinnaranga/Downloads/career.json';
const SCRATCH_DIR = '/Users/ravipatichinnaranga/.gemini/antigravity-ide/scratch';
const STATE_FILE = path.join(SCRATCH_DIR, 'scraper_progress.json');
const ENV_FILE = path.join(__dirname, '..', '.env.local');

// Load environment variables for DB if active
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  });
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/\([^)]*\)/g, '') // strip brackets
    .replace(/\b(private|pvt|ltd|limited|technologies|solutions|software|systems|services|it|consulting|group|engineering|centre|center|global|corporation|corp|inc|india)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function main() {
  console.log('📖 Reading career.json from:', CAREER_JSON_PATH);
  if (!fs.existsSync(CAREER_JSON_PATH)) {
    console.error('❌ career.json does not exist at:', CAREER_JSON_PATH);
    process.exit(1);
  }

  const rawContent = fs.readFileSync(CAREER_JSON_PATH, 'utf8');
  
  // Extract all JSON objects manually using regex to bypass any syntax/missing-comma errors
  const objectRegex = /\{[^{}]*\}/g;
  const matches = rawContent.match(objectRegex);
  
  if (!matches) {
    console.error('❌ Could not extract any JSON objects from career.json.');
    process.exit(1);
  }

  console.log(`Parsed ${matches.length} raw objects from career.json.`);

  const newCompanies = [];
  for (const matchStr of matches) {
    try {
      // Fix key-value quote formatting if needed, but since it's standard we can try direct JSON parse
      const obj = JSON.parse(matchStr);
      if (obj.name && obj.website_url) {
        let careersUrl = obj.website_url.trim();
        let websiteUrl = careersUrl;
        
        // Extract base website URL
        try {
          const parsed = new URL(careersUrl);
          websiteUrl = `${parsed.protocol}//${parsed.hostname}`;
        } catch (e) {}

        newCompanies.push({
          name: obj.name.trim(),
          website: websiteUrl,
          careers: careersUrl,
          status: 'pending',
          verified: true,
          timestamp: new Date().toISOString(),
          isScam: false,
          isFake: false,
          jobTracked: true
        });
      }
    } catch (err) {
      // Skip invalid items silently
    }
  }

  console.log(`✅ Loaded ${newCompanies.length} valid companies from career.json.`);

  // Load existing state
  let state = {
    status: 'idle',
    companies: [],
    currentIndex: 0,
    total: 0,
    startTime: null,
    endTime: null,
    logs: ['Scraper initialized.'],
    delayMs: 500,
    concurrency: 5,
    removedScamsCount: 0
  };

  if (fs.existsSync(STATE_FILE)) {
    console.log('📂 Loading existing scraper_progress.json from:', STATE_FILE);
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠️ Could not parse existing state file, starting fresh.');
    }
  }

  // Merge companies without duplicates
  const existingCompaniesMap = new Map();
  if (state.companies && Array.isArray(state.companies)) {
    for (const c of state.companies) {
      existingCompaniesMap.set(normalizeName(c.name), c);
    }
  }

  let mergedCount = 0;
  let addedCount = 0;

  for (const newC of newCompanies) {
    const norm = normalizeName(newC.name);
    if (existingCompaniesMap.has(norm)) {
      // Update existing if new careers/website is more specific
      const existing = existingCompaniesMap.get(norm);
      if (existing.careers === 'N/A' || existing.careers === '') {
        existing.careers = newC.careers;
        existing.website = newC.website;
        existing.verified = true;
        mergedCount++;
      }
    } else {
      state.companies.push(newC);
      existingCompaniesMap.set(norm, newC);
      addedCount++;
    }
  }

  state.total = state.companies.length;
  console.log(`📊 Ingestion complete:`);
  console.log(`   - Added: ${addedCount} new companies`);
  console.log(`   - Updated: ${mergedCount} existing companies`);
  console.log(`   - Total tracking target count: ${state.companies.length}`);

  // Save back to state file
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log('💾 Saved progress state to:', STATE_FILE);

  // If DB is configured, let's also upsert them into Postgres
  if (process.env.PG_CONN_STRING && !process.env.PG_CONN_STRING.includes('railway.internal')) {
    console.log('🔌 Connecting to Postgres to upload target companies...');
    const pool = new Pool({
      connectionString: process.env.PG_CONN_STRING,
      ssl: { rejectUnauthorized: false }
    });

    try {
      const client = await pool.connect();
      try {
        let dbAdded = 0;
        for (const c of state.companies) {
          await client.query(`
            INSERT INTO companies (company_name, website, careers_url, tier)
            VALUES ($1, $2, $3, 'Tier 3')
            ON CONFLICT (company_name) DO UPDATE SET
              website = EXCLUDED.website,
              careers_url = EXCLUDED.careers_url,
              updated_at = CURRENT_TIMESTAMP;
          `, [c.name, c.website, c.careers]);
          dbAdded++;
        }
        console.log(`✅ Upserted ${dbAdded} companies into PostgreSQL database.`);
      } finally {
        client.release();
      }
    } catch (dbErr) {
      console.warn('⚠️ Could not upload to Postgres database:', dbErr.message);
    } finally {
      await pool.end();
    }
  }

  console.log('✨ All done!');
}

main().catch(console.error);
