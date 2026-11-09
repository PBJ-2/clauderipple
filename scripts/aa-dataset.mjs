// Usage: AA_API_KEY=... node scripts/aa-dataset.mjs [previous.json] [--output path] [--limit N]
// --limit caps actual page fetches, not the output family list; partial local output must not publish.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_URL, extractPageRecords, mergeDataset, parseDataset, reusable, selectVariants } from './aa-dataset-lib.mjs';
// Documented V2 list endpoints; the legacy /api/v2/data/* paths returned HTTP 410 from 2026-11-04.
// The key's tier is unknown, so Pro is tried first; only its 403 (the tier does not cover it) retries the free path.
const PRO_URL = 'https://artificialanalysis.ai/api/v2/language/models';
const FREE_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
// Meanings the V2 docs give for error statuses; the response body's `error` and `message` are added as well.
const API_HINTS = { 401: 'missing or invalid key', 403: 'the key tier does not cover this endpoint', 429: 'daily quota exhausted' };
const USER_AGENT = 'Mozilla/5.0 (compatible; ClaudeRipple dataset (github.com/PBJ-2/clauderipple))';
const PAGE_GAP_MS = 1_500;
const BACKOFF_MS = 5_000;
// Pages of the model list (200 rows each in V2). Far above the catalogue; more means the list changed.
const MAX_LIST_PAGES = 20;

/** @param {unknown} raw @returns {import('./aa-dataset-lib.mjs').ApiRow[]} */
function apiRows(raw) {
  const data = raw && typeof raw === 'object' ? raw.data : undefined;
  if (!Array.isArray(data) || !data.length) throw new Error('AA API returned no model list');
  const numeric = value => value === null || (typeof value === 'number' && Number.isFinite(value));
  // The V2 creator is `{ id, name }` (Pro adds `country`); the family key uses its id and the dataset
  // names it by `name`. `release_date` is documented as an ISO date or null, and a row without a date
  // is kept (it is never tracked as recent). A free-tier row can carry a null creator; it cannot be
  // grouped, so it is skipped. A few old rows carry slugs like "glm-4.5" or "QwQ-32B-Preview" (seen
  // 2026-10-10): they are skipped, not fatal. Only a list where most rows look wrong means AA changed its format.
  const rows = data.filter(r => r && typeof r.slug === 'string' && /^[a-z0-9-]+$/.test(r.slug) && typeof r.name === 'string' && (r.release_date === undefined || r.release_date === null || typeof r.release_date === 'string') && typeof r.model_creator?.id === 'string' && typeof r.model_creator?.name === 'string' && numeric(r.evaluations?.artificial_analysis_intelligence_index) && numeric(r.pricing?.price_1m_input_tokens) && numeric(r.pricing?.price_1m_output_tokens));
  if (rows.length < data.length / 2) throw new Error('AA API model list changed shape');
  return rows;
}

/** @param {Response} response @returns {Promise<string[]>} the body's `error` and `message` strings, when present */
async function bodyStrings(response) {
  const body = await response.json().catch(() => null);
  return [body?.error, body?.message].filter(value => typeof value === 'string' && value);
}

/** @param {Response} response @returns {Promise<Error>} */
async function apiError(response) {
  const detail = [API_HINTS[response.status], ...(await bodyStrings(response))].filter(Boolean).join('; ').slice(0, 300);
  return new Error(`AA API failed: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
}

/**
 * Pro path first. Only its 403 retries the free path, once, with the same key. Any other failure
 * stays as it is; a 403 on both names both paths. The chosen path's pages are all read (see listPages).
 * @param {string} apiKey @param {typeof fetch} fetchImpl
 * @returns {Promise<{body:{intelligence_index_version?:unknown,data:unknown[]},path:string,afterProForbidden:boolean,pages:number}>}
 */
async function fetchModelList(apiKey, fetchImpl) {
  const get = url => fetchImpl(url, { headers: { 'x-api-key': apiKey, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  const pro = await get(PRO_URL);
  if (pro.status !== 403) {
    if (!pro.ok) throw await apiError(pro);
    return listPages(PRO_URL, await pro.json(), get, false);
  }
  await pro.body?.cancel();
  const free = await get(FREE_URL);
  if (free.status === 403) {
    const detail = ['the key tier covers neither endpoint', ...(await bodyStrings(free))].join('; ');
    throw new Error(`AA API failed: HTTP 403 on both /api/v2/language/models and /api/v2/language/models/free (${detail})`);
  }
  if (!free.ok) throw await apiError(free);
  return listPages(FREE_URL, await free.json(), get, true);
}

/** @param {unknown} body @param {number} page @returns {unknown[]} */
function pageRows(body, page) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) throw new Error(`AA API page ${page} has no model list`);
  return body.data;
}

/**
 * Every page of one list path, merged in order. Page 1 is the path itself; its `pagination` gives
 * `total_pages`, and each later page is asked for as `?page=n` (1-indexed, per the V2 docs). A page
 * that fails, answers another page, or disagrees on the total stops the run: a partial list would
 * publish the missing models as gone. The V2 schemas require `pagination`, so a response without it
 * is refused too: it may be page 1 of a longer list.
 * @param {string} url @param {any} first @param {(url:string)=>Promise<Response>} get @param {boolean} afterProForbidden
 * @returns {Promise<{body:{intelligence_index_version?:unknown,data:unknown[]},path:string,afterProForbidden:boolean,pages:number}>}
 */
async function listPages(url, first, get, afterProForbidden) {
  const pagination = first?.pagination;
  if (pagination === undefined) throw new Error('AA API list has no pagination; refusing what may be a partial list');
  const total = pagination?.total_pages;
  if (!Number.isInteger(total) || total < 1) throw new Error('AA API pagination changed shape');
  if (total > MAX_LIST_PAGES) throw new Error(`AA API list has ${total} pages, above the cap of ${MAX_LIST_PAGES}; refusing a partial list`);
  if (pagination.page !== 1 || pagination.has_more !== (total > 1)) throw new Error('AA API page 1 pagination is inconsistent');
  const data = [...pageRows(first, 1)];
  for (let page = 2; page <= total; page++) {
    const res = await get(`${url}?page=${page}`);
    if (!res.ok) throw await apiError(res);
    const body = await res.json();
    const more = page < total;
    if (body?.pagination?.page !== page || body.pagination.total_pages !== total || body.pagination.has_more !== more) throw new Error(`AA API page ${page} does not match the list's pagination`);
    data.push(...pageRows(body, page));
  }
  return { body: { ...first, data }, path: url, afterProForbidden, pages: total };
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
  const { body, path, afterProForbidden, pages } = await fetchModelList(apiKey, fetchImpl);
  log(`AA: data from ${path}${afterProForbidden ? ' (the Pro path answered 403 for this key)' : ''}`);
  log(`AA: intelligence_index_version ${body?.intelligence_index_version ?? 'not reported'}; ${pages} page${pages === 1 ? '' : 's'}`);
  const rows = apiRows(body);
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
