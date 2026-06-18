-- Enable vector extension for semantic deduplication
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Companies Table
CREATE TABLE IF NOT EXISTS companies (
    company_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name VARCHAR(255) UNIQUE NOT NULL,
    website VARCHAR(255),
    careers_url VARCHAR(255) NOT NULL,
    industry VARCHAR(100),
    country VARCHAR(100) DEFAULT 'India',
    city VARCHAR(100),
    employee_count INTEGER,
    tier VARCHAR(10) CHECK (tier IN ('Tier 1', 'Tier 2', 'Tier 3')) DEFAULT 'Tier 3',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Company Sources
CREATE TABLE IF NOT EXISTS company_sources (
    source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    source_type VARCHAR(50) CHECK (source_type IN ('company_career', 'ats', 'job_board', 'other')),
    source_url VARCHAR(500) NOT NULL,
    last_crawled_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. ATS Profiles Table
CREATE TABLE IF NOT EXISTS ats_profiles (
    ats_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(company_id) ON DELETE CASCADE,
    ats_type VARCHAR(50) CHECK (ats_type IN ('Greenhouse', 'Lever', 'Workday', 'Ashby', 'SmartRecruiters', 'Recruitee', 'BambooHR', 'Darwinbox', 'ZohoRecruit', 'SAPSuccessFactors', 'OracleTaleo', 'iCIMS', 'Comeet', 'Jobvite', 'Unknown')),
    fingerprint_hash VARCHAR(64) UNIQUE,
    custom_selector_rules JSONB,
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Jobs Table (ensure jobs_discovery has all columns)
CREATE TABLE IF NOT EXISTS jobs_discovery (
    job_id VARCHAR(100) PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    company_website VARCHAR(255),
    career_page_url TEXT,
    job_title VARCHAR(255) NOT NULL,
    job_url TEXT NOT NULL,
    location VARCHAR(255),
    city VARCHAR(255),
    state VARCHAR(255),
    country VARCHAR(100) DEFAULT 'India',
    work_mode VARCHAR(100),
    employment_type VARCHAR(100),
    experience_required VARCHAR(100),
    skills TEXT[],
    department VARCHAR(100),
    posted_date VARCHAR(100),
    application_deadline VARCHAR(100),
    status VARCHAR(50) DEFAULT 'OPEN',
    source_type VARCHAR(100) DEFAULT 'OFFICIAL',
    source_name VARCHAR(100),
    first_seen_timestamp VARCHAR(100),
    last_seen_timestamp VARCHAR(100),
    description TEXT,
    apply_url TEXT,
    ai_confidence NUMERIC(4,2),
    ai_model_used VARCHAR(150),
    ai_extracted BOOLEAN DEFAULT FALSE,
    review_needed BOOLEAN DEFAULT FALSE,
    match_score INTEGER,
    freshness_score INTEGER,
    composite_score INTEGER,
    tags TEXT[],
    salary_range VARCHAR(255),
    language VARCHAR(10) DEFAULT 'en',
    deadline VARCHAR(100),
    skill_matches TEXT[],
    skill_gaps TEXT[],
    match_explanation TEXT,
    company_id UUID REFERENCES companies(company_id) ON DELETE SET NULL
);

-- 5. Job Version History
CREATE TABLE IF NOT EXISTS job_versions (
    version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(100) REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Job Skills
CREATE TABLE IF NOT EXISTS job_skills (
    job_id VARCHAR(100) REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
    skill_name VARCHAR(100) NOT NULL,
    PRIMARY KEY (job_id, skill_name)
);

-- 7. Job Scores (Telemetry & Quality ranking)
CREATE TABLE IF NOT EXISTS job_scores (
    job_id VARCHAR(100) PRIMARY KEY REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
    freshness_score DOUBLE PRECISION NOT NULL,
    trust_score DOUBLE PRECISION NOT NULL,
    company_quality_score DOUBLE PRECISION NOT NULL,
    candidate_match_score DOUBLE PRECISION NOT NULL,
    composite_score DOUBLE PRECISION NOT NULL,
    explanation TEXT
);

-- 8. Job Embeddings (Semantic duplicate resolution)
CREATE TABLE IF NOT EXISTS job_embeddings (
    job_id VARCHAR(100) PRIMARY KEY REFERENCES jobs_discovery(job_id) ON DELETE CASCADE,
    embedding vector(1536) NOT NULL -- standard OpenAI/cohere size
);

-- 9. Crawl Queue & State Management
CREATE TABLE IF NOT EXISTS crawl_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url VARCHAR(500) UNIQUE NOT NULL,
    priority INTEGER DEFAULT 1,
    status VARCHAR(20) CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')) DEFAULT 'PENDING',
    retry_count INTEGER DEFAULT 0,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. Log Tables (Crawl and AI Logs)
CREATE TABLE IF NOT EXISTS crawl_logs (
    log_id SERIAL PRIMARY KEY,
    url VARCHAR(500) NOT NULL,
    worker_id VARCHAR(100),
    jobs_discovered INTEGER DEFAULT 0,
    status VARCHAR(50),
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_logs (
    log_id SERIAL PRIMARY KEY,
    job_id VARCHAR(100),
    model_id VARCHAR(100),
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    cost_usd NUMERIC(10, 6) DEFAULT 0.0,
    latency_ms INTEGER,
    confidence DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Real-time Aggregation Cache
CREATE TABLE IF NOT EXISTS analytics_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    metrics JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create scale indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status_last_seen ON jobs_discovery(status, last_seen_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_embedding ON job_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_priority_status ON crawl_queue(priority, status);
CREATE INDEX IF NOT EXISTS idx_company_name ON companies(company_name);
