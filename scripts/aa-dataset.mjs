// Usage: AA_API_KEY=... node scripts/aa-dataset.mjs [previous.json] [--output path] [--limit N]
// --limit caps actual page fetches, not the output family list; partial local output must not publish.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_URL, extractPageRecords, mergeDataset, parseDataset, reusable, selectVariants } from './aa-dataset-lib.mjs';
const API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const USER_AGENT = 'Mozilla/5.0 (compatible; ClaudeRipple dataset (github.com/PBJ-2/clauderipple))';
const PAGE_GAP_MS = 1_500;
const BACKOFF_MS = 5_000;

/** @param {unknown} raw @returns {import('./aa-dataset-lib.mjs').ApiRow[]} */
function apiRows(raw) {
  const data = raw && typeof raw === 'object' ? raw.data : undefined;
  if (!Array.isArray(data) || !data.length) throw new Error('AA API returned no model list');
  const numeric = value => value === null || (typeof value === 'number' && Number.isFinite(value));
  // A few old rows carry slugs like "glm-4.5" or "QwQ-32B-Preview" (seen 2026-10-10): they are
  // skipped, not fatal. Only a list where most rows look wrong means AA changed its format.
  const rows = data.filter(r => r && typeof r.slug === 'string' && /^[a-z0-9-]+$/.test(r.slug) && typeof r.name === 'string' && typeof r.release_date === 'string' && typeof r.model_creator?.name === 'string' && typeof r.model_creator?.slug === 'string' && numeric(r.evaluations?.artificial_analysis_intelligence_index) && numeric(r.pricing?.price_1m_input_tokens) && numeric(r.pricing?.price_1m_output_tokens));
  if (rows.length < data.length / 2) throw new Error('AA API model list changed shape');
  return rows;
}

/** @param {string|undefined} file @param {typeof fetch} fetchImpl @param {(message:string)=>void} warn */
async function previousDataset(file, fetchImpl, warn) {
  try {
    if (file) return parseDataset(JSON.parse(await fs.readFile(file, 'utf8')));
    const res = await fetchImpl(DATA_URL, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null; // first publication
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDataset(await res.json());
  } catch (e) {
    warn(`Previous dataset unavailable: ${e.message}; pages will be fetched again`);
    return null;
  }
}

/**
 * Network boundary, injectable for offline behavioral tests. All page attempts (including retry)
 * are sequential and spaced; a page succeeds only if its EXACT slug and cost shape parse.
 * @param {{apiKey:string,previous?:string,limit?:number,fetchImpl?:typeof fetch,wait?:(ms:number)=>Promise<void>,now?:()=>number,log?:(message:string)=>void}} options
 * @returns {Promise<import('./aa-dataset-lib.mjs').Dataset>}
 */
export async function runDataset(options) {
  const { apiKey, fetchImpl = fetch, wait = sleep, now = Date.now, log = console.error } = options;
  if (!apiKey) throw new Error('AA_API_KEY is not set');
  const response = await fetchImpl(API_URL, { headers: { 'x-api-key': apiKey, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`AA API failed: HTTP ${response.status}`);
  const rows = apiRows(await response.json());
  const at = now();
  const variants = selectVariants(rows, at);
  const previous = await previousDataset(options.previous, fetchImpl, log);
  const old = new Map((previous?.models ?? []).map(m => [m.slug, m]));
  const records = new Map();
  let attempted = 0, parsed = 0, lastRequest = -Infinity;
  for (const variant of variants) {
    const slug = variant.row.slug;
    if (reusable(old.get(slug), at) || records.has(slug)) continue;
    if (attempted >= (options.limit ?? Infinity)) break;
    attempted++;
    try {
      const res = await page(slug);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = extractPageRecords(await res.text());
      if (!found.some(r => r.slug === slug)) throw new Error('no valid record for requested slug (AA page format changed?)');
      parsed++;
      // Opportunistic values from this same response also refresh stale/default sibling records.
      for (const record of found) if (!reusable(old.get(record.slug), at)) records.set(record.slug, record);
      log(`${slug}: parsed (${found.length} embedded models)`);
    } catch (e) {
      log(`${slug}: ${e.message}; keeping previous values`);
    }
  }
  log(`AA: ${variants.length} variants; ${attempted} pages attempted, ${parsed} parsed`);
  if (attempted && parsed / attempted < 0.5) throw new Error(`AA page parse rate ${parsed}/${attempted} below 50%; refusing to publish`);
  return mergeDataset(variants, previous, [...records.values()], at);

  /** @param {string} slug */
  async function page(slug) {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      await wait(Math.max(0, PAGE_GAP_MS - (now() - lastRequest)));
      lastRequest = now();
      res = await fetchImpl(`https://artificialanalysis.ai/models/${slug}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (attempt || (res.status !== 429 && res.status < 500)) return res;
      await res.body?.cancel();
      const seconds = Number(res.headers.get('retry-after'));
      await wait(Math.max(BACKOFF_MS, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 60_000) : 0));
    }
    return res;
  }
}

/** @param {string[]} args */
function argumentsFor(args) {
  const options = { apiKey: process.env.AA_API_KEY ?? '', output: 'aa-models.json' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit') {
      const limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      options.limit = limit;
    } else if (arg === '--output') {
      const output = args[++i];
      if (!output) throw new Error('--output needs a path');
      options.output = output;
    } else if (!arg.startsWith('-') && !options.previous) options.previous = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    const dataset = await runDataset(options);
    await fs.writeFile(options.output, JSON.stringify(dataset, null, 2) + '\n');
  } catch (e) {
    console.error(`AA dataset failed: ${e.message}`);
    process.exitCode = 1;
  }
}
