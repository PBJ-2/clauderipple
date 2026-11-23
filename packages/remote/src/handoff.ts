import { execFile, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { batchCommand } from "./sdk-launcher.ts";

export interface HandoffRequest { sessionId: string; title: string; cwd: string }
export type HandoffRunner = (request: HandoffRequest) => Promise<string>;

/** macOS keeps script; Windows uses the OS's headless console (no visible window).
 * Measured on CLI 2.1.304: redirected stdout is rejected, even without --print.
 * --name is incompatible with --desktop; the persisted SDK title is read instead. */
export function desktopHandoff(claudePath: string, timeoutMs = 30_000, platform = process.platform): HandoffRunner | undefined {
  if (platform !== "darwin" && platform !== "win32") return undefined;
  return ({ sessionId, cwd }) => new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const args = ["--desktop", "--resume", sessionId];
    const batch = platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
    const command = platform === "darwin" ? "/usr/bin/script" : "conhost.exe";
    const cli = batch ? [`"${process.env.ComSpec ?? "cmd.exe"}"`, "/d", "/c", "call", batchCommand(claudePath, args)] : [claudePath, ...args];
    const child = spawn(command, platform === "darwin" ? ["-q", "/dev/null", claudePath, ...args] : ["--headless", ...cli], {
      // An ignored/closed stdin makes conhost exit before launching its child. Keep the pipe open.
      cwd, env, detached: platform === "darwin", windowsHide: true, windowsVerbatimArguments: batch,
      stdio: [platform === "darwin" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let output = "", timedOut = false;
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (platform === "win32") {
        // Include a batch launcher's descendants; negative process-group PIDs are POSIX-only.
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, error => {
          if (error && child.exitCode === null) {
            child.kill();
            reject(new Error(`timed out; taskkill failed: ${error.message}`));
          }
        });
      } else {
        // Kill the PTY wrapper and its CLI, not just the wrapper.
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
      }
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const detail = (platform === "win32" ? stripVTControlCharacters(output) : output).replace(/\s+/g, " ").trim();
      if (timedOut || code !== 0) reject(new Error(`${timedOut ? "timed out" : `exit ${code ?? signal}`} ${detail}`));
      // conhost returns 0 even when the CLI fails (including unsupported Windows ARM64).
      // Only the CLI's positive acknowledgement counts, never the wrapper's exit code alone.
      else if (platform === "win32" && !/Opening session\b.*\bin Claude Desktop\b/i.test(detail)) reject(new Error(detail || "desktop CLI exited without confirming handoff"));
      else resolve(detail || "opened");
    });
  });
}

/**
 * What a person types in a terminal on the host to continue a phone-created session when no Claude
 * app on that machine can take it over (Linux, or an app that lives on another machine over SSH).
 * The folder is quoted for the shell: POSIX single quotes, or cmd.exe double quotes on Windows.
 */
export function resumeCommand(cwd: string, sessionId: string, platform = process.platform): string {
  const id = /^[\w.-]+$/.test(sessionId) ? sessionId : `'${sessionId.replace(/'/g, "'\\''")}'`;
  if (platform === "win32") return `cd /d "${cwd.replace(/"/g, "")}" && claude --resume ${id}`;
  return `cd '${cwd.replace(/'/g, "'\\''")}' && claude --resume ${id}`;
}

/**
 * `desktop_handoff_unavailable` as plain Korean text, for a client that does not know the code
 * (web/i18n.ts carries the same words under "notice.desktop_handoff_unavailable"). Order: this
 * session is not in the Claude app on this computer, how to continue it in a terminal (the command
 * on its own line), then the request not to send from the phone meanwhile.
 */
export function handoffUnavailableText(command: string): string {
  return `이 세션은 이 컴퓨터의 Claude 앱에 표시되지 않습니다.\n이 컴퓨터의 터미널에서 이어서 작업하려면 다음 명령을 실행해 주세요.\n${command}\n터미널에서 이어서 작업하는 동안에는 휴대폰에서 메시지를 보내지 말아 주세요.`;
}
