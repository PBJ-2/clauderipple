// The client settings ClaudeRipple writes outside its home directory: the Claude Desktop proxy and
// picker flag, the Codex CLI provider, the CA trust, generated workers, and the status mod /
// agent-title hook / model slots. Uninstall removes them before --purge takes the CA and config.json
// they are found by.
//
// They are shared by every install on the account, so each goes only when it is this home's: the
// proxy only when it records this home, the Codex provider when its block records this home (an unmarked block only when its port
// is this installation's ingress and its service definition was this home's at uninstall start —
// see `legacyCodexIngressPort`), the CA by its fingerprint, worker files this home's manifest names
// and no other home keeps, and the status mod / agent-title hook / model slots only where this
// installation's own record (or its own home) says it wrote them. A release check installed under
// its own CLAUDERIPPLE_HOME then took the real install's Desktop proxy, Codex provider and CA with
// it on uninstall (2026-10-24; that time the real install used none of them). B01-B03, B22, 2026-10-25.
//
// Every step reports a structured outcome. Preserving another installation's recorded claim is a
// success; only an entry that cannot be identified, or a removal that failed, makes the uninstall
// incomplete.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "../../router/src/config.ts";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { defaultAgentDir, removeGeneratedAgentFiles } from "../../router/src/agents.ts";
import { certPaths } from "./certs.ts";
import { codexRemove } from "./codex.ts";
import { proxyUrlFor } from "./doctor.ts";
import { readOwners } from "./owners.ts";
import { sameHome } from "./ownership.ts";
import type { DesktopServiceDeps } from "./desktop-service.ts";
import { type CaRemoval, currentAppProxy, migrateLegacyAppProxy, removeAppProxy, untrustCa } from "./picker.ts";
import { setAgentTitleHook, setStatusMod, settingsPath } from "./settings.ts";
import { runtime } from "./runtime.ts";

/** The home an install without CLAUDERIPPLE_HOME uses: the one whose leftovers are swept. */
export function defaultHome(): string {
  return path.join(os.homedir(), ".clauderipple");
}

/** How one shared integration ended. Only `failed` and `preserved-unknown` block an uninstall. */
export type IntegrationOutcome = "removed" | "absent" | "preserved-other" | "preserved-unknown" | "failed";

const SEVERITY: Record<IntegrationOutcome, number> = { absent: 0, removed: 1, "preserved-other": 2, "preserved-unknown": 3, failed: 4 };

/** The outcome that needs the most attention among the ones reported. */
function worst(outcomes: IntegrationOutcome[]): IntegrationOutcome {
  return outcomes.reduce<IntegrationOutcome>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "absent");
}

/** The proxy port this installation's Claude Desktop entry points at, from its own config. */
function listenPort(home: string): number | undefined {
  try {
    const port = (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { listen?: { port?: unknown } }).listen?.port;
    return typeof port === "number" ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flip `picker.enabled` in config.json. The router and the GUI change the same file, so this is one
 * read-modify-write under the file's own lock, written atomically: every other key survives, and a
 * crash never leaves half a config behind (G-D04, 2026-10-25).
 */
export function setPickerEnabled(enabled: boolean, file = configPath()): void {
  withFileLock(file, () => {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object; left untouched`);
    const next = { ...(raw as Record<string, unknown>) };
    next.picker = { ...((next.picker as Record<string, unknown> | undefined) ?? {}), enabled };
    writeJsonAtomic(file, next);
  });
}

/**
 * Manifests whose worker names another installation still needs: the default home (a release check
 * must not take the real install's workers) and every home the shared ownership store knows about.
 * A broken store is not a reason to delete: the caller preserves the files and says so.
 */
function sharedWorkerManifests(home: string, fallback?: string): { files: string[]; error: string | null } {
  const owners = readOwners(settingsPath());
  if (owners.error) return { files: [], error: owners.error };
  const homes = new Set<string>([fallback ?? defaultHome(), ...Object.keys(owners.store.homes)]);
  const files = [...homes]
    .filter((other) => other.trim() !== "" && !sameHome(other, home))
    .map((other) => path.join(other, "generated-agents.json"));
  return { files, error: null };
}

/**
 * Best effort: one step that fails (a declined trust-removal dialog, say) does not stop the rest.
 * Returns whether every shared integration is gone or provably belongs to somebody else.
 */
export function removeClientIntegrations(
  home: string,
  removeTrust: (caPem: string, opts: { sweep?: boolean; missingCaTrustRemoved?: boolean }) => CaRemoval | boolean = untrustCa,
  opts: {
    modDir?: string;
    agentDir?: string;
    port?: number;
    defaultHome?: string;
    desktopService?: DesktopServiceDeps;
    /** Explicit user confirmation, never inferred from a missing ca.pem. */
    missingCaTrustRemoved?: boolean;
    /**
     * This installation's ingress port, passed only when its service definition was this home's
     * when the uninstall started. An unmarked legacy Codex block (an older version recorded no
     * home) is then this home's to remove; otherwise it is preserved.
     */
    legacyCodexIngressPort?: number;
  } = {},
): boolean {
  const rt = runtime();
  const proxyPort = opts.port ?? listenPort(home);
  const ourProxy = proxyPort === undefined ? undefined : proxyUrlFor(proxyPort);
  const notes: string[] = [];
  const steps: [string, () => IntegrationOutcome][] = [
    ["the status mod", () => {
      const primary = opts.modDir ?? rt.modDir;
      const results = primary ? [setStatusMod(false, primary, { home })] : [];
      const legacyDir = path.join(home, "mod");
      if (!sameHome(primary || legacyDir, legacyDir)) results.push(setStatusMod(false, legacyDir, { home }));
      for (const result of results) notes.push(...result.notes);
      return worst(results.map((result) => result.outcome ?? "failed"));
    }],
    ["the agent-title hook", () => {
      const result = setAgentTitleHook(false, { node: rt.node, script: rt.hookScript }, { home });
      notes.push(...result.notes);
      return result.outcome ?? "failed";
    }],
    ["generated worker files", () => {
      const manifest = path.join(home, "generated-agents.json");
      if (!fs.existsSync(manifest)) return "absent";
      const shared = sharedWorkerManifests(home, opts.defaultHome);
      if (shared.error) {
        notes.push(`left generated worker files and ${manifest}: the ownership record could not be read (${shared.error})`);
        return "preserved-unknown";
      }
      try {
        removeGeneratedAgentFiles(opts.agentDir ?? defaultAgentDir(), manifest, shared.files);
        return "removed";
      } catch (e) {
        notes.push(`left generated worker files and ${manifest}: ${(e as Error).message}`);
        return "preserved-unknown";
      }
    }],
    ["the Claude Desktop proxy", () => {
      const current = currentAppProxy();
      if (!current.egressProxyUrl) return "absent";
      if (!current.ours) {
        notes.push("left the Claude Desktop proxy: it is not a ClaudeRipple entry");
        return "preserved-other";
      }
      if (current.installationHome !== undefined) {
        if (!sameHome(current.installationHome, home)) {
          notes.push("left the Claude Desktop proxy: another installation owns it");
          return "preserved-other";
        }
      } else if (ourProxy === undefined || !migrateLegacyAppProxy(ourProxy, home, opts.desktopService)) {
        // A shared port alone is not evidence; migration also verifies the service and live PID.
        notes.push("left the Claude Desktop proxy: installation ownership is unknown");
        return "preserved-unknown";
      }
      if (ourProxy === undefined) {
        notes.push("left the Claude Desktop proxy: this installation's proxy port could not be read");
        return "preserved-unknown";
      }
      if (!removeAppProxy(ourProxy, home)) {
        notes.push("could not remove this installation's Claude Desktop proxy");
        return "failed";
      }
      return "removed";
    }],
    ["the picker setting", () => {
      const file = path.join(home, "config.json");
      if (!fs.existsSync(file)) return "absent";
      setPickerEnabled(false, file);
      return "removed";
    }],
    ["the Codex CLI provider", () => {
      // Only a block that records this installation goes; an older version's block is taken over
      // by `codex on`, or on uninstall only with the extra evidence the caller passes.
      const removal = codexRemove(undefined, {
        installationHome: home,
        ...(opts.legacyCodexIngressPort !== undefined ? { legacyIngressPort: opts.legacyCodexIngressPort } : {}),
      });
      if (removal.result === "other-installation") {
        notes.push("left the Codex CLI provider: it belongs to another ClaudeRipple installation");
        return "preserved-other";
      }
      if (removal.result === "ownership-unknown") {
        notes.push("left the Codex CLI provider: no installation is recorded for it (an older version's, or another installation's); run `clauderipple codex on` here to take it over");
        return "preserved-unknown";
      }
      return removal.result;
    }],
    ["the CA trust", () => {
      const reported = removeTrust(certPaths(home).caPem, { sweep: false, ...(opts.missingCaTrustRemoved === true ? { missingCaTrustRemoved: true } : {}) });
      // An injected boolean keeps its old meaning: true = removed, false = not confirmed.
      const result: CaRemoval = typeof reported === "boolean" ? (reported ? "removed" : "failed") : reported;
      if (result === "missing") {
        notes.push(`CA 파일이 없어 인증서 저장소 등록 여부를 확인하지 못했습니다. 원래 인증서를 ${certPaths(home).caPem} 경로에 복원해 주세요. 복원할 수 없다면 인증서 저장소에서 이 설치의 CA를 확인하고 제거한 뒤 \`clauderipple uninstall --purge --confirm-missing-ca-trust-removed\`를 실행해 주세요. 같은 이름의 다른 설치 인증서는 삭제하지 않도록 주의해 주세요.`);
        return "preserved-unknown";
      }
      if (result === "failed") {
        notes.push("CA trust removal was not confirmed; kept installation evidence");
        return "failed";
      }
      return result;
    }],
    ["the direct snapshot", () => {
      const snapshot = path.join(home, "direct.json");
      if (!fs.existsSync(snapshot)) return "absent";
      notes.push(`left ${snapshot}: connection restoration is still pending; run \`clauderipple direct off\` first`);
      return "preserved-unknown";
    }],
  ];
  const outcomes: IntegrationOutcome[] = [];
  for (const [name, remove] of steps) {
    try {
      outcomes.push(remove());
    } catch (e) {
      outcomes.push("failed");
      console.log(`  could not remove ${name}: ${(e as Error).message}`);
    }
  }
  for (const note of notes) console.log(`  note: ${note}`);
  return outcomes.every((outcome) => outcome === "removed" || outcome === "absent" || outcome === "preserved-other");
}
