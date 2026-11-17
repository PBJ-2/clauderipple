// Whether an install or update really put the router on the new version. The files being new proves
// nothing about the process: a router left running keeps serving the old code (ARCHITECTURE §5,
// "An update replaces the process, not only the files"). Pure; the callers read the version.

import type { AgentRestart } from "./ownership.ts";

/** A restart that ended with a new router answering; every other result left the old one in place. */
export function restartSwitched(result: AgentRestart): boolean {
  return result === "drained" || result === "kickstarted" || result === "direct";
}

/**
 * Why the router answering is not the version just installed, or null when it is (or nothing
 * answers: the end-to-end probe reports that on its own). Never reads a version as success by
 * default — the old router passing the probe is exactly what this guards against.
 */
export function versionMismatch(running: string | null, target: string): string | null {
  if (running === null || running === target) return null;
  return `the router still answering is ${running}, not ${target}`;
}
