// Pure AA dataset transformations. No network, filesystem, or token-count output.
/** @typedef {'max'|'xhigh'|'high'|'medium'|'low'|'minimal'|'non-reasoning'|null} Effort */
/** @typedef {{slug:string,name:string,release_date:string,model_creator:{name:string,slug:string},evaluations:{artificial_analysis_intelligence_index:number|null},pricing:{price_1m_input_tokens:number|null,price_1m_output_tokens:number|null}}} ApiRow */
/** @typedef {{slug:string,name:string,suffix:string|null,isReasoning:boolean,intelligenceIndex:number|null,intelligenceIndexIsEstimated:boolean,price1mInputTokens:number|null,price1mOutputTokens:number|null,intelligenceIndexCostPerTask?:{cost?:{total:number|null}}|null}} PageRecord */
/** @typedef {{slug:string,base:string,effort:Effort,name:string,creator:string,releaseDate:string,intelligence:number|null,intelligenceEstimated:boolean|null,costPerTask:number|null,priceIn:number|null,priceOut:number|null,checkedAt:string|null}} Model */
/** @typedef {{source:string,attribution:string,generatedAt:string,models:Model[]}} Dataset */
/** @typedef {{row:ApiRow,base:string,effort:Effort}} Variant */
export const SOURCE = 'https://artificialanalysis.ai';
export const ATTRIBUTION = 'Data: Artificial Analysis (artificialanalysis.ai)';
export const DATA_URL = 'https://raw.githubusercontent.com/PBJ-2/clauderipple/data/aa-models.json';
export const WINDOW_DAYS = 365;
export const REUSE_DAYS = 7;
const DAY_MS = 86_400_000;
const LEVEL = /(?:^|[,\s])(non-reasoning|xhigh|max|high|medium|low|minimal)(?=$|[,\s])/i;
const SLUG_LEVEL = /-(non-reasoning(?:-(?:low|high)-effort)?|xhigh|max|high|medium|low|minimal|reasoning|thinking)(?:-effort)?$/;

/** @param {string} slug */
export function baseSlug(slug) { return slug.replace(SLUG_LEVEL, ''); }

/**
 * Explicit suffix (or the name's last parentheses) wins over slug; Non-reasoning wins over
 * a simultaneous High/Low label. Generic Reasoning/default → max only in a multi-variant
 * family. A single-variant family always has null effort; never guess from e.g. Qwen-Max.
 * @param {{slug:string,name:string,suffix?:string|null,isReasoning?:boolean}} record
 * @param {boolean} multiple
 * @returns {Effort}
 */
export function deriveEffort(record, multiple) {
  if (!multiple) return null;
  const suffix = (record.suffix ?? record.name.match(/\(([^()]*)\)$/)?.[1] ?? '').toLowerCase();
  if (suffix.includes('non-reasoning')) return 'non-reasoning';
  const explicit = suffix.match(LEVEL)?.[1];
  if (explicit) return /** @type {Effort} */ (explicit);
  const tail = record.slug.match(SLUG_LEVEL)?.[1];
  if (tail && !['reasoning', 'thinking'].includes(tail)) return /** @type {Effort} */ (tail.startsWith('non-reasoning') ? 'non-reasoning' : tail);
  return record.isReasoning === false ? 'non-reasoning' : 'max';
}

/** Select recent measured families, including their old/unmeasured siblings. @param {ApiRow[]} rows @param {number} now @returns {Variant[]} */
export function selectVariants(rows, now = Date.now()) {
  // Names tie together AA's irregular slugs (e.g. reasoning vs non-reasoning preview ids).
  const reasoningSuffix = (/** @type {ApiRow} */ r) => {
    const suffix = r.name.match(/\(([^()]*)\)$/)?.[1] ?? '';
    return LEVEL.test(suffix) || /^reasoning(?:,|$)/i.test(suffix);
  };
  const familyKey = (/** @type {ApiRow} */ r) => `${r.model_creator.slug}:${(reasoningSuffix(r) ? r.name.replace(/\s*\([^()]*\)$/, '') : r.name).toLowerCase()}`;
  const groups = new Map();
  for (const row of rows) {
    const key = familyKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const variants = [];
  for (const family of groups.values()) {
    // Prefer the default/reasoning slug over a non-reasoning alternate with a different spelling.
    const ordered = [...family].sort((a, b) => Number(a.name.includes('Non-reasoning')) - Number(b.name.includes('Non-reasoning')) || baseSlug(a.slug).localeCompare(baseSlug(b.slug)));
    const base = reasoningSuffix(ordered[0]) ? baseSlug(ordered[0].slug) : ordered[0].slug;
    for (const row of family) variants.push({ row, base, effort: deriveEffort(row, family.length > 1) });
  }
  const tracked = new Set(variants.filter(({ row }) => {
    const date = Date.parse(row.release_date);
    return finiteOrNull(row.evaluations.artificial_analysis_intelligence_index) && row.evaluations.artificial_analysis_intelligence_index !== null && date >= now - WINDOW_DAYS * DAY_MS && date <= now;
  }).map(v => v.base));
  return variants.filter(v => tracked.has(v.base)).sort((a, b) => a.row.slug.localeCompare(b.row.slug));
}

/** @param {unknown} value @returns {boolean} */
function finiteOrNull(value) { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
/** @param {unknown} value @returns {value is PageRecord} */
function isPageRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {PageRecord} */ (value);
  return typeof r.slug === 'string' && typeof r.name === 'string' && (r.suffix === null || typeof r.suffix === 'string') && typeof r.isReasoning === 'boolean' && typeof r.intelligenceIndexIsEstimated === 'boolean' && finiteOrNull(r.intelligenceIndex) && finiteOrNull(r.price1mInputTokens) && finiteOrNull(r.price1mOutputTokens) && (r.intelligenceIndexCostPerTask === undefined || r.intelligenceIndexCostPerTask === null || finiteOrNull(r.intelligenceIndexCostPerTask?.cost?.total));
}

/** A model AA runs but does not price (e.g. open weights with no host) has no cost per task. @param {PageRecord} r */
function costOf(r) {
  return r.intelligenceIndexCostPerTask?.cost?.total ?? null;
}

/**
 * Decode JSON string arguments of Next flight pushes (not eval); then walk JSON braces while
 * respecting strings/escapes. The marker must be a direct key of the enclosing model object.
 * Return ALL records, never the first by position. Malformed candidates are ignored; callers
 * count exact requested-slug successes and fail if fewer than half their pages parse.
 * @param {string} html @returns {PageRecord[]}
 */
export function extractPageRecords(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m => JSON.parse(m[1]));
  const text = chunks.length ? chunks.join('') : html.includes('"canonicalIntelligenceIndexTokenCount":') ? html : html.replace(/\\"/g, '"');
  /** @type {{start:number,marked:boolean}[]} */
  const stack = [];
  const records = new Map();
  let string = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') string = false;
      continue;
    }
    if (c === '"') {
      // The page's own model is also `currentModel`, which carries no token counts (seen on
      // a-x-k2, 2026-10-10): `intelligenceIndexIsEstimated` marks model records of both kinds.
      if ((text.startsWith('"canonicalIntelligenceIndexTokenCount":', i) || text.startsWith('"intelligenceIndexIsEstimated":', i)) && stack.length) stack.at(-1).marked = true;
      string = true;
    } else if (c === '{') stack.push({ start: i, marked: false });
    else if (c === '}') {
      const frame = stack.pop();
      if (!frame?.marked) continue;
      try {
        const record = JSON.parse(text.slice(frame.start, i + 1));
        // Keep the copy that has a cost when a page carries the model twice.
        if (isPageRecord(record) && (costOf(record) !== null || !records.has(record.slug))) records.set(record.slug, record);
      } catch { /* A non-JSON candidate is not a parsed page; the runner reports its failure. */ }
    }
  }
  return [...records.values()];
}

/** @param {Model|undefined} model @param {number} now */
export function reusable(model, now = Date.now()) {
  const checked = Date.parse(model?.checkedAt ?? '');
  return Number.isFinite(checked) && checked <= now && now - checked < REUSE_DAYS * DAY_MS;
}

/** Merge only selected slugs; failed pages retain previous values AND timestamps. @param {Variant[]} variants @param {Dataset|null} previous @param {PageRecord[]} records @param {number} now @returns {Dataset} */
export function mergeDataset(variants, previous, records, now = Date.now()) {
  const old = new Map((previous?.models ?? []).map(m => [m.slug, m]));
  const fresh = new Map(records.map(r => [r.slug, r]));
  const at = new Date(now).toISOString();
  const models = variants.map(({ row, base, effort }) => {
    const prev = old.get(row.slug);
    const page = fresh.get(row.slug);
    return {
      slug: row.slug, base, effort: page ? deriveEffort(page, effort !== null) : effort, name: row.name, creator: row.model_creator.name, releaseDate: row.release_date,
      intelligence: page ? page.intelligenceIndex : prev ? prev.intelligence : row.evaluations.artificial_analysis_intelligence_index,
      intelligenceEstimated: page ? page.intelligenceIndexIsEstimated : prev?.intelligenceEstimated ?? null,
      costPerTask: (page ? costOf(page) : null) ?? prev?.costPerTask ?? null,
      priceIn: page ? page.price1mInputTokens : prev ? prev.priceIn : row.pricing.price_1m_input_tokens,
      priceOut: page ? page.price1mOutputTokens : prev ? prev.priceOut : row.pricing.price_1m_output_tokens,
      checkedAt: page ? at : prev?.checkedAt ?? null,
    };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
  return { source: SOURCE, attribution: ATTRIBUTION, generatedAt: at, models };
}

/** Content comparison ignores refresh timestamps, including on nested models. @param {Dataset|null} dataset */
export function meaningfulContent(dataset) {
  return JSON.stringify(dataset, (key, value) => key === 'generatedAt' || key === 'checkedAt' ? undefined : value);
}

/** Validate the external dataset at the network/disk boundary. @param {unknown} raw @returns {Dataset} */
export function parseDataset(raw) {
  const d = /** @type {Dataset} */ (raw);
  const efforts = [null, 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'non-reasoning'];
  if (!d || d.source !== SOURCE || d.attribution !== ATTRIBUTION || !Number.isFinite(Date.parse(d.generatedAt)) || !Array.isArray(d.models)) throw new Error('invalid AA dataset envelope');
  const slugs = new Set();
  for (const m of d.models) {
    if (!m || !['slug', 'base', 'name', 'creator', 'releaseDate'].every(k => typeof m[k] === 'string') || !m.slug || !m.base || !efforts.includes(m.effort) || ![m.intelligence, m.costPerTask, m.priceIn, m.priceOut].every(finiteOrNull) || ![null, true, false].includes(m.intelligenceEstimated) || !(m.checkedAt === null || Number.isFinite(Date.parse(m.checkedAt))) || slugs.has(m.slug)) throw new Error('invalid AA model record');
    slugs.add(m.slug);
  }
  return d;
}
