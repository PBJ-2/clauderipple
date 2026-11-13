// Worker thread of `DesktopSessions.reconvertFiles` (file-repair.ts): reading a transcript of hundreds
// of MB and checking each file the way a live conversion does takes seconds of CPU, which must not
// run on the host's own loop, where every phone's messages and approvals wait.
import { parentPort, workerData } from "node:worker_threads";
import { reconvertTranscript } from "./desktop.ts";

const port = parentPort!;
const { file, want, cwd, epoch } = workerData as { file: string; want: { lines: string[]; calls: string[] }; cwd: string; epoch: string };
const taken = (): Promise<void> => new Promise(resolve => port.once("message", () => resolve()));

await reconvertTranscript(file, { lines: new Set(want.lines), calls: new Set(want.calls) }, cwd, epoch, async (bodies, data) => {
  // One line at a time: the next waits until the host has taken this one.
  const ack = taken();
  port.postMessage({ bodies, data: [...data] });
  await ack;
});
port.postMessage({ done: true });
