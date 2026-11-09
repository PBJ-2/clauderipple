// Pure AA dataset transformations. No network, filesystem, or token-count output.
/** @typedef {'max'|'xhigh'|'high'|'medium'|'low'|'minimal'|'non-reasoning'|null} Effort */
/** @typedef {{slug:string,name:string,release_date:string|null|undefined,reasoning_model?:boolean,model_creator:{id:string,name:string},evaluations:{artificial_analysis_intelligence_index:number|null},artificial_analysis_intelligence_index_cost?:{cost_per_task?:{total_cost:number}|null}|null,pricing:{price_1m_input_tokens:number|null,price_1m_output_tokens:number|null}}} ApiRow */
/** @typedef {{slug:string,base:string,effort:Effort,name:string,creator:string,releaseDate:string,intelligence:number|null,intelligenceEstimated:boolean|null,costPerTask:number|null,priceIn:number|null,priceOut:number|null,checkedAt:string|null}} Model */
/** @typedef {{source:string,attribution:string,generatedAt:string,models:Model[]}} Dataset */
/** @typedef {{row:ApiRow,base:string,effort:Effort}} Variant */
export const SOURCE = 'https://artificialanalysis.ai';
export const ATTRIBUTION = 'Data: Artificial Analysis (artificialanalysis.ai)';
export const WINDOW_DAYS = 365;
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
  const familyKey = (/** @type {ApiRow} */ r) => `${r.model_creator.id}:${(reasoningSuffix(r) ? r.name.replace(/\s*\([^()]*\)$/, '') : r.name).toLowerCase()}`;
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
    for (const row of family) variants.push({ row, base, effort: deriveEffort({ slug: row.slug, name: row.name, isReasoning: row.reasoning_model }, family.length > 1) });
  }
  const tracked = new Set(variants.filter(({ row }) => {
    const date = Date.parse(row.release_date);
    return finiteOrNull(row.evaluations.artificial_analysis_intelligence_index) && row.evaluations.artificial_analysis_intelligence_index !== null && date >= now - WINDOW_DAYS * DAY_MS && date <= now;
  }).map(v => v.base));
  return variants.filter(v => tracked.has(v.base)).sort((a, b) => a.row.slug.localeCompare(b.row.slug));
}

/** @param {unknown} value @returns {boolean} */
function finiteOrNull(value) { return value === null || (typeof value === 'number' && Number.isFinite(value)); }
/** AA's documented cost per task (USD, rounded to 4 decimals) on both tiers. Null when AA does not price the model. @param {ApiRow} row */
function costPerTaskOf(row) {
  return row.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null;
}

/** The dataset from one V2 list read. Every value comes from that read, so checkedAt is the read time. AA's list and model pages no longer report whether the index is estimated, so intelligenceEstimated is null. @param {Variant[]} variants @param {number} now @returns {Dataset} */
export function buildDataset(variants, now = Date.now()) {
  const at = new Date(now).toISOString();
  const models = variants.map(({ row, base, effort }) => ({
    slug: row.slug, base, effort, name: row.name, creator: row.model_creator.name, releaseDate: row.release_date ?? '',
    intelligence: row.evaluations.artificial_analysis_intelligence_index, intelligenceEstimated: null, costPerTask: costPerTaskOf(row),
    priceIn: row.pricing.price_1m_input_tokens, priceOut: row.pricing.price_1m_output_tokens, checkedAt: at,
  })).sort((a, b) => a.slug.localeCompare(b.slug));
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
