import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as failureModel from "../src/failure-model.ts";
import * as statusModel from "../src/status-model.ts";
import * as updateModel from "../src/update-model.ts";

// Evaluate the real main module with startup held at Electron's readiness boundary. No CLI,
// filesystem, network, native window, login item or updater can run in this harness.
const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source + `
exports.inspectTray = (status, language, fakeTray) => { last = status; L = STRINGS[language]; tray = fakeTray; render(); };
exports.health = healthy;
exports.showFailure = (language, message, output, retry) => { L = STRINGS[language]; return showFailure(message, output, retry); };
exports.strings = STRINGS;
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

type MessageBox = { type?: string; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number };

type WindowQuota = { used_percent?: number; window_minutes?: number };
type Fixture = {
  settings: { HTTPS_PROXY?: string }; listen: { host: string; port: number };
  providers: Record<string, { reachable: boolean }>; consecutiveUpstreamFailures: number;
  readiness?: { ready: boolean; problems: string[] };
  chatgpt?: { quota: Record<string, { plan_type?: string; rate_limits?: { primary?: WindowQuota | null; secondary?: WindowQuota | null } } | null> };
};
const good = (): Fixture => ({ settings: { HTTPS_PROXY: "http://127.0.0.1:1" }, listen: { host: "127.0.0.1", port: 1 }, providers: { test: { reachable: true } }, consecutiveUpstreamFailures: 0 });
function harness() {
  const labels: string[] = [];
  let image = "", tooltip = "";
  const forbidden = () => { throw new Error("Unexpected OS, filesystem, CLI or network access"); };
  // Dialogs answer from `answers` in order (the cancel button when it runs out); `shown` keeps each.
  const answers: number[] = [], shown: MessageBox[] = [], copied: string[] = [];
  const fakeTray = {
    setImage: (value: { file: string }) => { image = value.file; },
    setToolTip: (value: string) => { tooltip = value; },
    setContextMenu: (items: { label?: string }[]) => { labels.splice(0, labels.length, ...items.flatMap(item => item.label ? [item.label] : [])); },
  };
  const modules: Record<string, object> = {
    electron: {
      app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }), isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }), getPreferredSystemLanguages: () => ["ko"], getSystemLocale: () => "ko", getLocale: () => "ko" },
      Menu: { buildFromTemplate: (items: object[]) => items },
      nativeImage: { createFromPath: (file: string) => ({ file, setTemplateImage() {} }) },
      // Copied out of the module's realm, whose arrays deepEqual would not take for this realm's.
      dialog: { showMessageBox: async (options: MessageBox) => { shown.push(JSON.parse(JSON.stringify(options))); return { response: answers.shift() ?? options.cancelId ?? 0 }; } },
      clipboard: { writeText: (text: string) => { copied.push(text); } },
    },
    "node:child_process": { execFile: forbidden }, "node:fs": new Proxy({}, { get: () => forbidden }),
    "node:os": { homedir: forbidden }, "node:path": path,
    "./claude-desktop": { claudeStartedAt: forbidden, reopenClaude: forbidden },
    "./update-model": updateModel, "./status-model": statusModel, "./failure-model": failureModel,
    "./protocol": { registerScheme() {}, ORIGIN: "ripple://app" },
    "./window": { mainWindow: () => null },
  };
  const exports: {
    inspectTray?: (status: Fixture, lang: string, tray: typeof fakeTray) => void;
    health?: (status: Fixture | null) => string;
    showFailure?: (lang: string, message: string, output: string, retry?: () => Promise<void>) => Promise<void>;
    strings?: Record<string, { failures: Record<string, [string, string]> }>;
  } = {};
  runInNewContext(compiled, {
    exports, require: (id: string) => { assert.ok(id in modules, id); return modules[id]; },
    process: { env: { CLAUDERIPPLE_HOME: "/tmp/unused-tray-status" }, platform: process.platform },
    __dirname: "/tmp/unused-tray-status/src", console, fetch: forbidden, setTimeout: forbidden, setInterval: forbidden,
  });
  assert.ok(exports.inspectTray);
  assert.ok(exports.health);
  assert.ok(exports.showFailure);
  assert.ok(exports.strings);
  const inspect = exports.inspectTray;
  return {
    health: exports.health,
    render: (status: Fixture, lang = "ko") => { inspect(status, lang, fakeTray); return { labels, image, tooltip }; },
    showFailure: exports.showFailure,
    strings: exports.strings,
    answers, shown, copied,
  };
}

// The update that failed on 2026-10-29 while cargo held the CPU, cut to the lines that matter here.
const starvedUpdate = [
  "Updating ClaudeRipple 0.12.14 → 0.12.22 (install script, C:\\Users\\me\\.clauderipple)…",
  "added 7 packages, and changed 127 packages in 54s",
  "✓ router already running",
  "✗ probe failed: router unreachable: connect ECONNREFUSED 127.0.0.1:8790",
  "the installer exited with 1",
  "Command failed: C:\\Program Files\\nodejs\\node.exe C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple\\dist\\cli\\src\\index.js update",
].join("\n");

test("a failed update names the failure, offers its fix, and keeps the output behind Details", async () => {
  const app = harness();
  // Details, Copy, Close the output, Close the failure.
  app.answers.push(1, 0, 1, 2);
  await app.showFailure("ko", "업데이트를 완료하지 못했습니다", starvedUpdate, async () => assert.fail("a router that did not answer is not fixed by downloading again"));
  const [failure, output, copiedOutput, again] = app.shown;
  assert.equal(app.shown.length, 4);
  assert.equal(failure!.title, "ClaudeRipple");
  assert.equal(failure!.message, "업데이트를 완료하지 못했습니다");
  assert.deepEqual(failure!.buttons, ["설정 다시 실행", "자세히", "닫기"]);
  assert.equal(failure!.defaultId, 0);
  assert.equal(failure!.cancelId, 2);
  assert.equal(failure!.detail, app.strings.ko!.failures["router-unresponsive"]!.join("\n"));
  assert.doesNotMatch(failure!.detail!, /ECONNREFUSED|Command failed|installer exited/);
  assert.equal(output!.message, "전체 출력");
  assert.match(output!.detail!, /ECONNREFUSED 127\.0\.0\.1:8790/);
  assert.deepEqual(app.copied, [starvedUpdate]);
  assert.equal(copiedOutput!.message, "전체 출력 (복사됨)");
  assert.deepEqual(again, failure, "closing the output returns to the failure");
});

test("a failure with no fix the tray can run offers only Details and Close", async () => {
  const app = harness();
  await app.showFailure("en", "Setup did not finish", 'error: settings.json env.HTTPS_PROXY is already "http://127.0.0.1:9000".');
  assert.equal(app.shown.length, 1);
  assert.deepEqual(app.shown[0]!.buttons, ["Details", "Close"]);
  assert.equal(app.shown[0]!.defaultId, 1);
  assert.equal(app.shown[0]!.cancelId, 1);
  assert.match(app.shown[0]!.detail!, /^Another proxy in use\n/);
});

test("an update that could not download offers to try again, and the button runs it", async () => {
  const app = harness();
  let retried = 0;
  app.answers.push(0);
  await app.showFailure("en", "The update did not finish", "npm error code ENOTFOUND", async () => { retried++; });
  assert.deepEqual(app.shown[0]!.buttons, ["Try Again", "Details", "Close"]);
  assert.equal(retried, 1);
});

test("every tray language names every failure", () => {
  const kinds = ["router-not-switched", "router-not-started", "startup-entry", "certificate", "router-unresponsive", "anthropic-unreachable", "foreign-proxy", "disk-full", "files-unwritable", "download", "unknown"];
  const { strings } = harness();
  for (const [lang, table] of Object.entries(strings)) {
    assert.deepEqual(Object.keys(table.failures).sort(), [...kinds].sort(), lang);
    for (const [kind, text] of Object.entries(table.failures)) {
      assert.equal(text.length, 2, `${lang} ${kind}`);
      assert.ok(text.every((part) => part.trim().length > 0), `${lang} ${kind}`);
    }
  }
});

for (const problem of ["picker-ca", "picker-proxy"]) {
  test(`readiness ${problem} failure changes the actual tray headline, icon and tooltip`, () => {
    const app = harness();
    const status = { ...good(), readiness: { ready: false, problems: [problem] } };
    assert.equal(app.health(status), "warn");
    const shown = app.render(status);
    assert.ok(shown.labels.includes("ClaudeRipple · 확인 필요"));
    assert.match(shown.image, /tray(?:Win)?Warn(?:Template)?\.png$/);
    assert.equal(shown.tooltip, "ClaudeRipple warn");
    assert.ok(shown.labels.some(label => label.includes(problem === "picker-ca" ? "인증서 신뢰 필요" : "프록시 설정 필요")));
  });
}

test("readiness is authoritative even if the old heuristic disagrees", () => {
  const app = harness();
  assert.equal(app.health({ ...good(), settings: {}, providers: { native: { reachable: false } }, consecutiveUpstreamFailures: 3, readiness: { ready: true, problems: [] } }), "ok");
  assert.equal(app.health({ ...good(), readiness: { ready: false, problems: [] } }), "warn");
});

test("older servers retain proxy, provider and upstream checks; no answer remains down", () => {
  const { health } = harness();
  assert.equal(health(null), "down");
  assert.equal(health(good()), "ok");
  assert.equal(health({ ...good(), settings: {} }), "warn");
  assert.equal(health({ ...good(), providers: { test: { reachable: false } } }), "warn");
  assert.equal(health({ ...good(), consecutiveUpstreamFailures: 1 }), "warn");
});

function quotaStatus(primary?: WindowQuota | null, secondary?: WindowQuota | null): Fixture {
  return { ...good(), chatgpt: { quota: { test: { plan_type: "plus", rate_limits: { primary, secondary } } } } };
}

test("ChatGPT primary five-hour usage and secondary weekly usage both appear with their real periods", () => {
  const shown = harness().render(quotaStatus({ used_percent: 21, window_minutes: 300 }, { used_percent: 64, window_minutes: 10080 }));
  assert.ok(shown.labels.some(label => label.includes("ChatGPT plus · 5시간 21% · 주간 64%")));
  assert.ok(shown.labels.every(label => !label.includes("이번 주")));
});

test("weekly primary and secondary-only windows do not depend on their slot order", () => {
  const app = harness();
  assert.ok(app.render(quotaStatus({ used_percent: 42, window_minutes: 10080 })).labels.some(label => label.includes("ChatGPT plus · 주간 42%")));
  assert.ok(app.render(quotaStatus(null, { used_percent: 0, window_minutes: 300 })).labels.some(label => label.includes("ChatGPT plus · 5시간 0%")));
});

test("other periods are formatted as minutes, and missing periods are never called weekly", () => {
  const app = harness();
  const minutes = new Intl.NumberFormat("ko", { style: "unit", unit: "minute", unitDisplay: "short" }).format(60);
  assert.ok(app.render(quotaStatus({ used_percent: 8, window_minutes: 60 })).labels.some(label => label.includes(`${minutes} 8%`)));
  assert.ok(app.render(quotaStatus({ used_percent: 9 })).labels.some(label => label.includes("ChatGPT plus · ? 9%")));
  assert.ok(app.render(quotaStatus({}, null)).labels.every(label => !label.includes("ChatGPT plus")));
});

test("all existing tray translations use the five-hour and weekly window labels", () => {
  const expected = { en: ["5h", "weekly"], ko: ["5시간", "주간"], zh: ["5 小时", "每周"], ja: ["5時間", "週間"], es: ["5 h", "semanal"], pt: ["5h", "semanal"] };
  const app = harness();
  for (const [lang, [fiveHour, week]] of Object.entries(expected)) {
    const shown = app.render(quotaStatus({ used_percent: 3, window_minutes: 300 }, { used_percent: 7, window_minutes: 10080 }), lang);
    assert.ok(shown.labels.some(label => label.includes(`ChatGPT plus · ${fiveHour} 3% · ${week} 7%`)), lang);
  }
});
