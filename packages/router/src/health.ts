// Self-healing: a long-lived process whose resolver or socket layer has gone bad
// stays bad (observed: 10h of ENOTFOUND, 11 remote-control workers lost). After N
// consecutive upstream *connect-level* failures with no success in between, exit
// with a distinctive code so the supervisor restarts a fresh process.

export const EXIT_UPSTREAM_UNREACHABLE = 75;

const CONNECT_ERRORS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

export function isConnectError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}

export class UpstreamHealth {
  private consecutive = 0;
  private tripped = false;
  private readonly limit: () => number;
  private readonly onTrip: (n: number) => void;

  constructor(limit: () => number, onTrip: (n: number) => void) {
    this.limit = limit;
    this.onTrip = onTrip;
  }

  success(): void {
    this.consecutive = 0;
  }

  failure(e: unknown): void {
    if (!isConnectError(e)) return;
    this.consecutive++;
    if (!this.tripped && this.consecutive >= this.limit()) {
      this.tripped = true;
      this.onTrip(this.consecutive);
    }
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }
}
