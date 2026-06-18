/**
 * In-memory URL cache with TTL.
 * Prevents re-processing URLs already classified/extracted in the current session.
 */

import type { AiExtractResult } from './validator';

interface CacheEntry {
  result: AiExtractResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Default TTL: 2 hours */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

function normalizeKey(url: string): string {
  return url.split('?')[0].toLowerCase().replace(/\/$/, '');
}

export function getCachedExtraction(url: string): AiExtractResult | null {
  const key = normalizeKey(url);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCachedExtraction(url: string, result: AiExtractResult, ttlMs = DEFAULT_TTL_MS): void {
  const key = normalizeKey(url);
  cache.set(key, { result, expiresAt: Date.now() + ttlMs });
}

export function isUrlCached(url: string): boolean {
  const key = normalizeKey(url);
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return false;
  }
  return true;
}

/** Returns cache stats for diagnostics */
export function getCacheStats(): { size: number; entries: string[] } {
  const now = Date.now();
  // Prune expired entries
  for (const [k, v] of cache.entries()) {
    if (now > v.expiresAt) cache.delete(k);
  }
  return { size: cache.size, entries: Array.from(cache.keys()).slice(0, 20) };
}

export function clearCache(): void {
  cache.clear();
}
