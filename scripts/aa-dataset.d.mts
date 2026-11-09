import type { Dataset } from './aa-dataset-lib.mjs';
export function runDataset(options: {
  apiKey: string; fetchImpl?: typeof fetch; now?: () => number; log?: (message: string) => void;
}): Promise<Dataset>;
