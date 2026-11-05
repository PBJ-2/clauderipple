// Tray-side view of /api/status. Fields stay optional for routers predating automatic updates.
export type RouterUpdate = {
  enabled?: boolean;
  running?: boolean;
  hostUpdate?: { version: string; status: "pending" | "applied" | "skipped"; error?: string };
  kind?: string;
  available?: string;
  lastUpdatedFrom?: string;
  lastUpdatedTo?: string;
  lastUpdatedAt?: number;
  lastError?: string;
};
export type UpdateSeen = { updated: string[]; available: string[] };
export type UpdateNotice = { kind: "updated"; version: string; relaunch: boolean } | { kind: "available"; version: string };

/**
 * The version of the running tray. Electron answers with its own version when it was started from
 * a script file rather than a folder, which is how the CLI starts an npm install: getVersion() said
 * 38.8.6 beside a 0.12.14 router, so every router looked newly updated and the tray replaced itself
 * every couple of seconds (Discord report, 0.12.14). A packaged build carries its version in its
 * bundle and answers right; the unpackaged ones have it in the package.json the build writes beside
 * the tray (dist/app) or the workspace keeps (packages/app) — read through `packageVersion`.
 */
export function resolveTrayVersion(packaged: boolean, electronVersion: string, packageVersion: string | null): string {
  if (packaged) return electronVersion;
  return packageVersion?.trim() || electronVersion;
}

/** How many times one router/tray version pair may be replaced before the tray stays where it is. */
export const REPLACEMENT_LIMIT = 3;

/** Replacement attempts for one version pair, kept on disk: each attempt ends this process, so no run can count them. */
export type ReplacementTries = { routerVersion: string; trayVersion: string; attempts: number };

export function readReplacementTries(value: unknown): ReplacementTries | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ReplacementTries>;
  if (typeof v.routerVersion !== "string" || typeof v.trayVersion !== "string"
    || typeof v.attempts !== "number" || !Number.isFinite(v.attempts)) return null;
  return { routerVersion: v.routerVersion, trayVersion: v.trayVersion, attempts: Math.max(0, Math.floor(v.attempts)) };
}

/** A pair still not matching after this many launches will not start matching on its own. */
export function replacementExhausted(previous: ReplacementTries | null, routerVersion: string, trayVersion: string, limit = REPLACEMENT_LIMIT): boolean {
  if (!previous || previous.routerVersion !== routerVersion || previous.trayVersion !== trayVersion) return false;
  return previous.attempts >= limit;
}

export function nextReplacementTries(previous: ReplacementTries | null, routerVersion: string, trayVersion: string): ReplacementTries {
  const same = previous?.routerVersion === routerVersion && previous.trayVersion === trayVersion;
  return { routerVersion, trayVersion, attempts: (same ? previous.attempts : 0) + 1 };
}


export function readUpdateSeen(value: unknown): UpdateSeen {
  if (!value || typeof value !== "object") throw new Error("invalid update notification state");
  const s = value as Partial<UpdateSeen>;
  if (!Array.isArray(s.updated) || !Array.isArray(s.available)
    || [...s.updated, ...s.available].some((v) => typeof v !== "string")) throw new Error("invalid update notification versions");
  return { updated: s.updated, available: s.available };
}

/** No I/O or Electron: only confirmed completion is a reason to replace a running tray. */
export function updateNotice(routerVersion: string, trayVersion: string, state: RouterUpdate | undefined, seen: UpdateSeen): UpdateNotice | null {
  if (!state) return null;
  if (!state.running && state.lastUpdatedTo === routerVersion && state.lastUpdatedFrom && state.lastUpdatedFrom !== routerVersion
    && typeof state.lastUpdatedAt === "number" && Number.isFinite(state.lastUpdatedAt) && !seen.updated.includes(routerVersion)) {
    return { kind: "updated", version: routerVersion, relaunch: trayVersion !== routerVersion && (state.kind === "script" || state.kind === "npm") };
  }
  const version = state.available;
  const automatic = state.enabled !== false && (state.kind === "script" || state.kind === "npm");
  if (version && version !== routerVersion && !state.running && !automatic && !seen.available.includes(version)) {
    return { kind: "available", version };
  }
  return null;
}
/** Replacement completion is not notification history. Failed launches back off, even on the same target. */
export class TrayReplacement {
  private active = false;
  private target = "";
  private completed = "";
  private retryAt = 0;
  private failures = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  async reconcile(routerVersion: string, trayVersion: string, state: RouterUpdate | undefined, replace: () => Promise<void>): Promise<void> {
    const notice = updateNotice(routerVersion, trayVersion, state, { updated: [], available: [] });
    if (notice?.kind !== "updated" || !notice.relaunch || this.active || this.completed === routerVersion) return;
    if (this.target !== routerVersion) { this.target = routerVersion; this.retryAt = 0; this.failures = 0; }
    if (this.now() < this.retryAt) return;
    this.active = true;
    try { await replace(); this.completed = routerVersion; }
    catch (error) {
      this.retryAt = this.now() + Math.min(15 * 60_000, 60_000 * 2 ** this.failures++);
      throw error;
    } finally { this.active = false; }
  }
}

/** The GitHub release that lists what changed in `version`; an unexpected version string gets the latest release. */
export function releaseNotesUrl(version: string): string {
  const base = "https://github.com/PBJ-2/clauderipple/releases";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? `${base}/tag/v${version}` : `${base}/latest`;
}

export function rememberUpdate(seen: UpdateSeen, notice: UpdateNotice): UpdateSeen {
  return { ...seen, [notice.kind]: [...new Set([...seen[notice.kind], notice.version])] };
}
