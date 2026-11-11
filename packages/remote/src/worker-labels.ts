// What a pinned worker's model reads as to a person: the host fills `modelLabel` on every worker
// event it logs. The account names come from the router's worker files (`/api/mod-options`
// `agents[].account`), kept here because an event is built where no router call can be awaited.
import { isPinnedModelId, workerModelLabel, type AccountNames } from "../web/worker-label.ts";

let accounts: AccountNames = {};

/** Replace the known account names (`<provider>#<pin>` → display name). */
export function setWorkerAccounts(next: AccountNames): void { accounts = next; }

/** The label for a pinned worker's id; undefined for any other id, which is shown as it is. */
export function workerLabelFor(model: string | null | undefined): string | undefined {
  return isPinnedModelId(model) ? workerModelLabel(model, accounts) : undefined;
}

/** Read the names now and again every minute (an account can be added or renamed). Never throws. */
export function keepWorkerAccountsFresh(read: () => Promise<AccountNames>, log: (line: string) => void = () => {}): () => void {
  const refresh = (): void => { read().then(setWorkerAccounts, (e: Error) => log(`worker account names: ${e.message}`)); };
  refresh();
  const timer = setInterval(refresh, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
