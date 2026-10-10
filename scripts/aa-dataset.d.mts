import type { Dataset } from './aa-dataset-lib.mjs';
export function runDataset(options: {
  apiKey: string; previous?: string; limit?: number; fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>; now?: () => number; log?: (message: string) => void;
}): Promise<Dataset>;
