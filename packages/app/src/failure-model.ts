// What a failed update, setup or router switch printed, sorted into the failures a person can act
// on. An update prints npm's lines and every install step, and the line that says what went wrong
// sits in the middle: the update dialog of 2026-10-29 was a screenful ending in "Command failed:
// … index.js update", with the cause ("✗ probe failed: router unreachable: connect ECONNREFUSED")
// eleven lines above it. The tray names each failure found here in the user's words and keeps the
// whole output behind its Details button.

/** The failures an output can show. Each has a title and a sentence in the tray's string table. */
export type FailureKind =
  | "router-not-switched"
  | "router-not-started"
  | "startup-entry"
  | "certificate"
  | "router-unresponsive"
  | "anthropic-unreachable"
  | "foreign-proxy"
  | "disk-full"
  | "files-unwritable"
  | "download"
  | "unknown";

/** What the failure dialog can offer to do, each an action the tray already has. */
export type FailureAction = "restart" | "repair" | "setup" | "retry";

// One kind per line: the first rule that matches a line decides it, so a line such as "! not
// restarted: the scheduled task belongs to another ClaudeRipple installation" counts as a router
// left on the old version, not as a startup entry problem. The lines come from the CLI (index.ts
// install, restart and update; probe.ts; schtasks.ts, launchd.ts and systemd.ts registration), the
// install scripts, npm and PowerShell.
const RULES: { kind: FailureKind; test: RegExp }[] = [
  { kind: "router-not-switched", test: /was not switched to|! not restarted:|✗ router not restarted/ },
  { kind: "router-not-started", test: /could not start the router|start failed \(is it installed\?\)/ },
  {
    kind: "startup-entry",
    test: /Register-ScheduledTask failed|scheduled task lookup failed|could not read the scheduled task|launchctl bootstrap failed|systemctl --user .+ failed|router started without the|belongs to another ClaudeRipple installation|does not record an installation/,
  },
  { kind: "certificate", test: /probe failed: (?:cannot read CA|TLS not authorized)/ },
  { kind: "router-unresponsive", test: /probe failed: (?:router unreachable|timeout)/ },
  { kind: "anthropic-unreachable", test: /probe failed: (?:CONNECT refused|TLS error|upstream answered|connection closed)/ },
  { kind: "foreign-proxy", test: /HTTPS_PROXY is already/ },
  { kind: "disk-full", test: /\bENOSPC\b|no space left on device/i },
  { kind: "files-unwritable", test: /\b(?:EBUSY|EPERM|EACCES)\b|resource busy or locked/ },
  // npm and curl name the network error; PowerShell's message is in the system language, so its
  // error id is matched instead.
  {
    kind: "download",
    test: /\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|npm registry answered|installer download failed|Could not resolve host|WebCmdletWebResponseException|published checksum/,
  },
];

/**
 * The failures in `output`, in the order they first appear, each once. A router that could not be
 * started also fails the connection check after it, and that second line adds nothing, so it is
 * dropped. An output with none of the known lines is "unknown".
 */
export function failureKinds(output: string): FailureKind[] {
  const found: FailureKind[] = [];
  for (const line of output.split(/\r?\n/)) {
    const kind = RULES.find((rule) => rule.test.test(line))?.kind;
    if (kind && !found.includes(kind)) found.push(kind);
  }
  const kinds = found.includes("router-not-started") ? found.filter((kind) => kind !== "router-unresponsive") : found;
  return kinds.length ? kinds : ["unknown"];
}

const ACTIONS: Partial<Record<FailureKind, FailureAction>> = {
  "router-not-switched": "restart",
  "router-not-started": "repair",
  "startup-entry": "repair",
  "certificate": "setup",
  "router-unresponsive": "setup",
  "anthropic-unreachable": "setup",
  "disk-full": "retry",
  "files-unwritable": "retry",
  "download": "retry",
};

/**
 * The one action the dialog offers: that of the first failure with an action the caller can run.
 * Only an update can be retried, so the setup and router-switch dialogs offer nothing for a failed
 * download.
 */
export function failureAction(kinds: readonly FailureKind[], available: ReadonlySet<FailureAction>): FailureAction | null {
  for (const kind of kinds) {
    const action = ACTIONS[kind];
    if (action && available.has(action)) return action;
  }
  return null;
}
