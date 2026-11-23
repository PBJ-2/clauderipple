// What the host does with an error nobody caught. Node's default for both is to print and exit 1
// (an unhandled rejection is raised as an uncaught exception), which made a stray rejection from one
// session end every session with no word of why in the log (#162).
//
//  - A rejection nobody awaited is logged with its stack and the host keeps running: one failed
//    background call must not take down every phone connection.
//  - An uncaught exception leaves the process in an unknown state. It is logged and the process exits
//    non-zero, as before: launchd's KeepAlive and the Windows launcher's loop both relaunch a
//    non-zero exit and treat a clean exit as "stopped on purpose" (cli/src/schtasks.ts).

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
  proc.on("unhandledRejection", (reason) => {
    opts.log(`[host] unhandled rejection (host keeps running)${where()}: ${describeError(reason)}`);
  });
  let exiting = false;
  proc.on("uncaughtException", (error, origin) => {
    opts.log(`[host] uncaught exception (${origin})${where()}: ${describeError(error)}; exiting with code 1 so the supervisor restarts the host`);
    if (exiting) return;
    exiting = true;
    opts.exit(1);
  });
}
