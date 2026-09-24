// Opens a URL in the user's default browser. Shared by the CLI (sign-in commands, `ui`) and the
// router's admin API (sign-in started from the GUI).

import { execFileSync } from "node:child_process";

/** Returns false if the platform command failed; the caller then shows the URL instead. */
export function openBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      // Not `cmd /c start`: cmd treats & as a command separator, so an OAuth URL arrives truncated
      // at its first parameter and the provider answers "missing_required_parameter" (observed
      // 2026-09-14). Start-Process takes the URL as one argument, quoted PowerShell-style.
      const quoted = `'${url.replace(/'/g, "''")}'`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process ${quoted}`], { stdio: "ignore", windowsHide: true });
    } else execFileSync(process.platform === "linux" ? "xdg-open" : "open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
