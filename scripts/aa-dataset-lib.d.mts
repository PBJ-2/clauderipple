export type Effort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'non-reasoning' | null;
export type ApiRow = {
  slug: string; name: string; release_date: string | null | undefined;
  reasoning_model?: boolean;
  model_creator: { id: string; name: string };
  evaluations: { artificial_analysis_intelligence_index: number | null };
  artificial_analysis_intelligence_index_cost?: { cost_per_task?: { total_cost: number } | null } | null;
  pricing: { price_1m_input_tokens: number | null; price_1m_output_tokens: number | null };
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
export const WINDOW_DAYS: number;
export function baseSlug(slug: string): string;
export function deriveEffort(record: { slug: string; name: string; suffix?: string | null; isReasoning?: boolean }, multiple: boolean): Effort;
export function selectVariants(rows: ApiRow[], now?: number): Variant[];
export function buildDataset(variants: Variant[], now?: number): Dataset;
export function meaningfulContent(dataset: Dataset | null): string | undefined;
export function parseDataset(raw: unknown): Dataset;
