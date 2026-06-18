import { pool, isPgAvailable } from '../db';
import { callOpenRouter } from './openrouter-client';

/**
 * Fetch text embedding vector from OpenRouter (1536 dimensions)
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ No OPENROUTER_API_KEY set, skipping embedding generation.');
    return null;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/text-embedding-3-small',
        input: text.slice(0, 4000) // limit characters to stay safe
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.warn(`⚠️ Embeddings API returned HTTP ${response.status}`);
      return null;
    }

    const json = await response.json();
    if (json?.data?.[0]?.embedding) {
      return json.data[0].embedding as number[];
    }
  } catch (err: any) {
    console.warn('⚠️ Failed to generate embedding via OpenRouter:', err.message);
  }

  return null;
}

/**
 * Jaccard word-overlap similarity coefficient between two texts.
 * Used as a fallback when database/vector extensions are offline.
 */
function calculateLocalSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().match(/\b\w+\b/g) || []);
  const wordsB = new Set(textB.toLowerCase().match(/\b\w+\b/g) || []);

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Main entry point for semantic duplicate checking.
 */
export async function findDuplicateSemanticJob(
  jobTitle: string,
  jobDesc: string,
  companyName: string,
  embedding?: number[] | null
): Promise<string | null> {
  // 1. Database-driven pgvector check
  if (isPgAvailable && pool) {
    try {
      const vector = embedding || (await getEmbedding(`${jobTitle} ${jobDesc.slice(0, 300)}`));
      if (!vector) return null;

      const embeddingString = `[${vector.join(',')}]`;
      const result = await pool.query(
        `SELECT j.job_id, j.job_title, j.description, j.company_name
         FROM job_embeddings e
         JOIN jobs_discovery j ON j.job_id = e.job_id
         WHERE j.status = 'OPEN'
           AND LOWER(REPLACE(j.company_name, ' ', '')) = LOWER(REPLACE($2, ' ', ''))
         ORDER BY e.embedding <=> $1::vector
         LIMIT 3`,
        [embeddingString, companyName]
      );

      for (const row of result.rows) {
        // Double-check using LLM reasoning verification
        const duplicatePrompt = `You are a verification engine. Determine if the following two job listings describe the EXACT same role opening:
        
        Job A: ${jobTitle} at ${companyName}
        Description A: ${jobDesc.slice(0, 300)}
        
        Job B: ${row.job_title} at ${row.company_name}
        Description B: ${row.description.slice(0, 300)}
        
        Respond ONLY in JSON format: {"is_duplicate": true|false, "confidence": 0.0-1.0}`;

        const verification = await callOpenRouter({
          systemPrompt: 'You check for duplicate job listings.',
          userContent: duplicatePrompt,
          model: 'google/gemma-4-26b-a4b-it:free',
          maxTokens: 50,
          temperature: 0.0
        });

        if (verification.success && verification.content) {
          try {
            const match = verification.content.match(/\{[\s\S]*\}/);
            const decision = JSON.parse(match ? match[0] : verification.content);
            if (decision.is_duplicate && decision.confidence > 0.85) {
              console.log(`[Deduplicator] Semantic duplicate verified by LLM: ${row.job_id}`);
              return row.job_id;
            }
          } catch (e) {
            // fallback if JSON parsing fails
            if (verification.content.toLowerCase().includes('"is_duplicate": true')) {
              return row.job_id;
            }
          }
        }
      }
    } catch (dbErr: any) {
      console.warn('⚠️ Semantic vector search failed, fallback to local text heuristics:', dbErr.message);
    }
  }

  // 2. Fallback heuristic check (if PG vector search failed or is unavailable)
  const normTitle = jobTitle.toLowerCase().replace(/\s+/g, '');
  const normCompany = companyName.toLowerCase().replace(/\s+/g, '');

  if (isPgAvailable && pool) {
    try {
      const result = await pool.query(
        `SELECT job_id, job_title, description FROM jobs_discovery 
         WHERE status = 'OPEN' 
           AND LOWER(REPLACE(company_name, ' ', '')) = $1`,
        [normCompany]
      );

      for (const row of result.rows) {
        const titleSim = calculateLocalSimilarity(jobTitle, row.job_title);
        const descSim = calculateLocalSimilarity(jobDesc.slice(0, 400), row.description.slice(0, 400));
        
        // If titles overlap highly (>70%) and descriptions overlap (>60%), mark as duplicate
        if (titleSim > 0.7 && descSim > 0.6) {
          console.log(`[Deduplicator] Fallback heuristic duplicate detected: ${row.job_id} (Title similarity: ${titleSim.toFixed(2)}, Desc similarity: ${descSim.toFixed(2)})`);
          return row.job_id;
        }
      }
    } catch (err) {
      // ignore
    }
  }

  return null;
}
