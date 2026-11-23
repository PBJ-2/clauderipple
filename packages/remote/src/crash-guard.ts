// What the host does with an error nobody caught. Node's default for both is to print and exit 1
// (an unhandled rejection is raised as an uncaught exception), which ended every session with no
// word of why in the log (#162).
//
// Both are logged with their stack and then the process exits non-zero, exactly as Node would. Keeping
// the host alive after a stray rejection was tried and rejected: a rejection can come from the middle
// of a session's own bookkeeping, and a host that carries on after it can acknowledge phone messages
// that no live query will ever run. The supervisor's restart is the recovery: launchd's KeepAlive and
// the Windows launcher's loop both relaunch a non-zero exit and read a clean exit as "stopped on
// purpose" (cli/src/schtasks.ts).

export interface CrashProcess {
  on(event: "unhandledRejection", listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error, origin: string) => void): unknown;
}

/** One line to read in a log: the error's stack when it has one, else its text. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return (error.stack ?? `${error.name}: ${error.message}`).replace(/\s*\n\s*/g, " | ");
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); }
  catch { return String(error); }
}

export function installCrashHandlers(proc: CrashProcess, opts: { log: (line: string) => void; exit: (code: number) => void; context?: () => string }): void {
  const where = (): string => {
    try { return opts.context?.() ?? ""; }
    catch { return ""; }
  };
  let exiting = false;
  const die = (what: string, error: unknown): void => {
    // A log that cannot be written must not keep the process from exiting.
    try { opts.log(`[host] ${what}${where()}: ${describeError(error)}; exiting with code 1 so the supervisor restarts the host`); }
    catch { /* nothing left to tell */ }
    if (exiting) return;
    exiting = true;
    opts.exit(1);
  };
  proc.on("unhandledRejection", (reason) => die("unhandled rejection", reason));
  proc.on("uncaughtException", (error, origin) => die(`uncaught exception (${origin})`, error));
}
