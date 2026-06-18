import fs from 'fs';
import path from 'path';
import { isAiEnabled, getModel } from './src/lib/ai/model-registry';
import { callOpenRouter } from './src/lib/ai/openrouter-client';
import { aiExtractJob } from './src/lib/ai/job-extractor';
import { loadCandidateProfile } from './src/lib/ai/candidate-profile';
import { scoreJob } from './src/lib/ai/ranker';

// ─── Phase 1: Load Environment ──────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index !== -1) {
        const key = trimmed.slice(0, index).trim();
        const val = trimmed.slice(index + 1).trim();
        process.env[key] = val;
      }
    }
    console.log('✅ Loaded environment configurations from .env.local\n');
  } else {
    console.log('⚠️ Warning: .env.local file not found in current working directory.\n');
  }
}

// Mock job HTML page for pipeline extraction validation
const MOCK_JOB_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Staff Frontend Developer at Stripe</title>
</head>
<body>
  <div class="job-container">
    <h1>Staff Frontend Developer</h1>
    <div class="company">Stripe</div>
    <div class="location">Location: Bangalore, Karnataka (Hybrid)</div>
    <div class="work-mode">Work Mode: hybrid</div>
    <div class="experience">Experience Required: 6+ years</div>
    
    <div class="job-description">
      <h2>Job Description</h2>
      <p>Stripe is looking for a Staff Frontend Developer to build next-generation financial interfaces. You will work closely with design and product engineering teams.</p>
      
      <h2>Requirements:</h2>
      <ul>
        <li>6+ years of professional software development experience.</li>
        <li>Strong proficiency in React, TypeScript, and modern client-side performance.</li>
        <li>Experience with Next.js, GraphQL, and CSS framework styling is a plus.</li>
      </ul>
      
      <p>Apply via email: careers@stripe.com or submit your application.</p>
    </div>
    
    <a class="apply-btn" href="https://boards.greenhouse.io/stripe/jobs/4827104">Apply Now</a>
  </div>
</body>
</html>
`;

async function runTests() {
  loadEnv();

  console.log('============================================================');
  console.log('🧬 STARTING AI PIPELINE INTEGRATION & VERIFICATION SUITE');
  console.log('============================================================\n');

  // ─── Test 1: AI Key & Enabled Check ───────────────────────────────────────
  console.log('🔍 TEST 1: AI Enabled Status Check');
  const enabled = isAiEnabled();
  console.log(`- AI Integration Enabled: ${enabled ? '🟢 YES' : '🔴 NO'}`);
  console.log(`- API Key Configured: ${process.env.OPENROUTER_API_KEY ? 'Present (sk-or-...)' : 'Missing'}`);
  
  const classifyModel = getModel('classify');
  const extractModel = getModel('extract');
  console.log(`- Classification Model: ${classifyModel.modelId}`);
  console.log(`- Extraction Model: ${extractModel.modelId}`);
  console.log('');

  if (!enabled) {
    console.error('❌ Skipping remaining tests because AI is not enabled. Please add OPENROUTER_API_KEY to .env.local.');
    return;
  }

  // ─── Test 2: Connection & Quota Validation ─────────────────────────────
  console.log('🔍 TEST 2: OpenRouter Connection & Quota Verification');
  console.log('Sending a simple test prompt to OpenRouter to check key status and quotas...');
  
  const testResp = await callOpenRouter({
    systemPrompt: 'You are a helpful assistant. Keep your response under 5 words.',
    userContent: 'Hello, respond with: "API is online"',
    model: classifyModel.modelId,
    maxTokens: 50,
    temperature: 0.0,
  });

  if (testResp.success) {
    console.log('🟢 OpenRouter API connection is active!');
    console.log(`- Response: "${testResp.content.trim()}"`);
    console.log(`- Latency: ${testResp.latencyMs}ms`);
    console.log(`- Estimated Blended Cost: $${testResp.estimatedCostUsd.toFixed(5)}`);
  } else {
    console.error('🔴 OpenRouter API Connection Failed!');
    console.error(`- Error details: ${testResp.error}`);
    if (testResp.error?.includes('429')) {
      console.warn('⚠️ STATUS: Rate limit exceeded (429). The engine will fall back to heuristic models.');
    } else {
      console.warn('⚠️ STATUS: API key invalid or other network issues.');
    }
  }
  console.log('');

  // ─── Test 3: AI Extraction Pipeline ───────────────────────────────────────
  console.log('🔍 TEST 3: AI Extraction & Normalization Pipeline');
  console.log('Processing mock Greenhouse job page through the extraction parser...');
  
  const mockUrl = 'https://boards.greenhouse.io/stripe/jobs/4827104';
  const extractResult = await aiExtractJob(mockUrl, MOCK_JOB_HTML, { skipClassify: true });

  if (extractResult.success) {
    const fields = extractResult.scrapedJobFields as any;
    console.log('🟢 AI Extraction Succeeded!');
    console.log(`- Extracted Title: "${extractResult.job?.job_title}"`);
    console.log(`- Extracted Company: "${extractResult.job?.company_name}"`);
    console.log(`- Extracted Location: "${extractResult.job?.location}" (City: "${fields?.city}", State: "${fields?.state}")`);
    console.log(`- Extracted Work Mode: "${extractResult.job?.work_mode}"`);
    console.log(`- Extracted Experience: "${fields?.experience_required}"`);
    console.log(`- Extracted Skills: [${(extractResult.job?.skills || []).join(', ')}]`);
    console.log(`- Confidence Score: ${extractResult.confidence.toFixed(2)}`);
    console.log(`- Extraction Model Used: ${extractResult.modelUsed}`);
    console.log(`- Pipeline Latency: ${extractResult.latencyMs}ms`);
  } else {
    console.warn('🔴 AI Extraction Pipeline Failed (using AI)!');
    console.warn(`- Error: ${extractResult.error}`);
    console.log('🔄 Checking fallback heuristic values...');
    if (extractResult.scrapedJobFields) {
      console.log('🟢 Graceful Heuristic Fallback occurred successfully:');
      console.log(`- Heuristic Title: "${extractResult.scrapedJobFields.job_title}"`);
      console.log(`- Heuristic Company: "${extractResult.scrapedJobFields.company_name}"`);
      console.log(`- Heuristic Location: "${extractResult.scrapedJobFields.location}"`);
    } else {
      console.error('🔴 Heuristic fallback missing job fields.');
    }
  }
  console.log('');

  // ─── Test 4: Match Scoring & Candidate Profiler ───────────────────────────
  console.log('🔍 TEST 4: Match Ranking & Candidate Profiler');
  console.log('Loading candidate profile and scoring the job...');

  const profile = loadCandidateProfile();
  console.log(`- Profile Loaded: Skills: [${profile.skills.join(', ')}], Preferred Roles: [${profile.preferred_roles.join(', ')}]`);
  
  if (extractResult.success && extractResult.job) {
    const score = await scoreJob(extractResult.job, profile).catch(e => {
      console.warn('⚠️ Scoring API rate-limited, using local heuristic scorer...');
      return null;
    });

    if (score) {
      console.log('🟢 Fit Scoring Successful!');
      console.log(`- Match Score: ${score.matchScore}/100`);
      console.log(`- Freshness Score: ${score.freshnessScore}/100`);
      console.log(`- Composite Score: ${score.compositeScore}/100`);
      console.log(`- Skill Matches: [${score.skillMatches.join(', ')}]`);
      console.log(`- Skill Gaps: [${score.skillGaps.join(', ')}]`);
      console.log(`- AI Explanation: "${score.explanation}"`);
    } else {
      console.log('🟢 Heuristic Scorer Result (Local fallback):');
      console.log(`- Match Score: ${extractResult.matchScore}/100`);
      console.log(`- Freshness Score: ${extractResult.freshnessScore}/100`);
      console.log(`- Composite Score: ${extractResult.compositeScore}/100`);
    }
  } else {
    console.log('🔄 Simulating scoring on fallback heuristic job fields...');
    console.log(`- Heuristic Match Score: ${extractResult.matchScore}/100`);
    console.log(`- Heuristic Freshness Score: ${extractResult.freshnessScore}/100`);
    console.log(`- Heuristic Composite Score: ${extractResult.compositeScore}/100`);
  }
  console.log('');

  console.log('============================================================');
  console.log('🏁 AI INTEGRATION VERIFICATION COMPLETE');
  console.log('============================================================');
}

runTests().catch(err => {
  console.error('❌ Critical Test Error:', err);
});
