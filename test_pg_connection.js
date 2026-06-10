const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Manually read and parse .env.local
const envPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
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

console.log('Conn String:', process.env.PG_CONN_STRING);
const pool = new Pool({
  connectionString: process.env.PG_CONN_STRING,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT COUNT(*), COUNT(DISTINCT job_id) FROM jobs_discovery')
  .then(res => {
    console.log('Success count query:', res.rows);
    return pool.query(`
      SELECT job_title, company_name, COUNT(*)
      FROM jobs_discovery
      GROUP BY job_title, company_name
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `);
  })
  .then(res => {
    console.log('Top duplicates:', res.rows);
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
