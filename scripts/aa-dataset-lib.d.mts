export type Effort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'non-reasoning' | null;
export type ApiRow = {
  slug: string; name: string; release_date: string;
  model_creator: { name: string; slug: string };
  evaluations: { artificial_analysis_intelligence_index: number | null };
  pricing: { price_1m_input_tokens: number | null; price_1m_output_tokens: number | null };
};
export type PageRecord = {
  slug: string; name: string; suffix: string | null; isReasoning: boolean;
  intelligenceIndex: number | null; intelligenceIndexIsEstimated: boolean;
  price1mInputTokens: number | null; price1mOutputTokens: number | null;
  intelligenceIndexCostPerTask?: { cost?: { total: number | null } } | null;
};
export type Model = {
  slug: string; base: string; effort: Effort; name: string; creator: string; releaseDate: string;
  intelligence: number | null; intelligenceEstimated: boolean | null; costPerTask: number | null;
  priceIn: number | null; priceOut: number | null; checkedAt: string | null;
};
export type Dataset = { source: string; attribution: string; generatedAt: string; models: Model[] };
export type Variant = { row: ApiRow; base: string; effort: Effort };
export const SOURCE: string;
export const ATTRIBUTION: string;
export const DATA_URL: string;
export const WINDOW_DAYS: number;
export const REUSE_DAYS: number;
export function baseSlug(slug: string): string;
export function deriveEffort(record: { slug: string; name: string; suffix?: string | null; isReasoning?: boolean }, multiple: boolean): Effort;
export function selectVariants(rows: ApiRow[], now?: number): Variant[];
export function extractPageRecords(html: string): PageRecord[];
export function reusable(model: Model | undefined, now?: number): boolean;
export function mergeDataset(variants: Variant[], previous: Dataset | null, records: PageRecord[], now?: number): Dataset;
export function meaningfulContent(dataset: Dataset | null): string | undefined;
export function parseDataset(raw: unknown): Dataset;
