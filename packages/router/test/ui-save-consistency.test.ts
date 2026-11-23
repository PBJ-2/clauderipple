import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Execute the dashboard's real rendering, save, retry, toast and keyboard functions. Only browser
// DOM/timers and fetch are replaced: there is no listener, network request or real configuration.
const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
function block(from: string, to: string) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing UI block: ${from}`);
  return source.slice(start, end);
}
type Route = { provider: string; model: string; effort?: string; contextWindow?: number; fallbacks?: { provider: string; model: string }[] };
type Config = { configRevision?: string; routes: Record<string, Route>; providers: Record<string, { type: string; models: { id: string; effortLevels?: string[] }[] }>; cli?: { models: Record<string, string> }; autoUpdate?: boolean };
type KeyEvent = { key: string; target: DomNode; defaultPrevented: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean; preventDefault(): void };
class DomNode {
  children: DomNode[] = [];
  parent: DomNode | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((event: KeyEvent) => void)[]>();
  hidden = false;
  disabled = false;
  checked = false;
  isContentEditable = false;
  // A mapping row colours its vendor dot through the style object, as the page's CSP requires.
  style: Record<string, string> = {};
  textContent = '';
  private selectedValue: string | undefined;
  readonly classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set className(value: string) { this.attrs.class = value; }
  get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : ''); }
  get value(): string {
    if (this.tagName !== 'SELECT') return this.selectedValue ?? this.attrs.value ?? '';
    const options = this.descendants().filter(node => node.tagName === 'OPTION');
    return this.selectedValue === undefined ? options[0]?.value ?? '' : options.some(node => node.value === this.selectedValue) ? this.selectedValue : '';
  }
  set value(value: string) { this.selectedValue = value; }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  removeAttribute(key: string) { delete this.attrs[key]; }
  append(...children: DomNode[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  appendChild(child: DomNode) { this.append(child); return child; }
  replaceChildren(...children: DomNode[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  descendants(): DomNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(node: DomNode): boolean { return node === this || this.descendants().includes(node); }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s.startsWith('#')) return this.attrs.id === s.slice(1);
      if (s.startsWith('.')) return (this.attrs.class || '').split(' ').includes(s.slice(1));
      if (s === '[data-default-action]') return 'data-default-action' in this.attrs;
      if (s === 'select[data-slot]') return this.tagName === 'SELECT' && 'slot' in this.dataset;
      return this.tagName === s.toUpperCase();
    });
  }
  closest(selector: string): DomNode | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): DomNode[] { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector: string): DomNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name: string, listener: (event: KeyEvent) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(keyEvent(this, '')); }
  click() { if (!this.disabled) this.emit('click'); }
  focus() {}
}
function keyEvent(target: DomNode, key = 'Enter', extra: Partial<KeyEvent> = {}): KeyEvent {
  return { target, key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
}
function fixture(): Config {
  return {
    configRevision: 'r1',
    providers: { p: { type: 'openai-compatible', models: ['one', 'two', 'three'].map(id => ({ id, effortLevels: ['low', 'high'] })) } },
    routes: {
      a: { provider: 'p', model: 'one', effort: 'high', contextWindow: 123456 },
      b: { provider: 'p', model: 'two', effort: 'high', fallbacks: [{ provider: 'p', model: 'three' }] },
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(initial = fixture()) {
  const root = new DomNode('DOCUMENT');
  const nodes = Object.fromEntries(['slots-list', 'slots-summary', 'slots-status', 'toast', 'modal-content', 'modal-backdrop', 'modal-close', 'client-model-slots'].map(id => {
    const node = new DomNode('DIV'); node.attrs.id = id; root.append(node); return [id, node];
  }));
  const queryAll = (selector: string): DomNode[] => {
    const [first, ...rest] = selector.split(' ');
    const parents = root.querySelectorAll(first!);
    return rest.length ? parents.flatMap(node => node.querySelectorAll(rest.join(' '))) : parents;
  };
  let keyboard: (event: KeyEvent) => void = () => { throw new Error('keydown not registered'); };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const h = {
    latest: structuredClone(initial), writes: [] as Config[], reads: 0,
    warning: '', failRead: false, failPut: false,
    beforeRead: null as (() => Promise<void>) | null,
    beforePut: null as (() => Promise<void>) | null,
  };
  const fetchMock = async (url: string, options?: { method?: string; body?: string }) => {
    assert.equal(url, '/api/config', 'only the mock config endpoint is allowed');
    const response = (body: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
    if (options?.method !== 'PUT') {
      h.reads++; if (h.beforeRead) await h.beforeRead();
      if (h.failRead) throw new Error('offline');
      return response(h.latest);
    }
    const sent = JSON.parse(options.body!) as Config; h.writes.push(structuredClone(sent));
    if (h.beforePut) await h.beforePut();
    if (h.failPut) return response({ error: 'write failed' }, 500);
    if (sent.configRevision !== undefined && sent.configRevision !== h.latest.configRevision) return response({ error: 'conflict' }, 409);
    h.latest = structuredClone(sent);
    if (h.latest.configRevision !== undefined) h.latest.configRevision = `r${h.writes.length + 1}`;
    return response({ ok: true, configRevision: h.latest.configRevision, ...(h.warning ? { warning: h.warning } : {}) });
  };
  const ui = new Function('document', 'window', 'Node', 'fetch', 'setTimeout', 'clearTimeout', `
    const t = key => key, APP = null;
    let currentConfig = null, slotsLoaded = false, effortCatalog = null;
    const claudeModels = ['a', 'b', 'c'].map(id => ({id})), CHATGPT_MODELS = [];
    const loadCatalogs = async () => {}, presets = [];
    ${block('function $(', '// Inside the ClaudeRipple app')}
    ${block('let toastTimer =', 'function modelsOf(')}
    ${block('function modelsOf(', 'let pickerContextWindows =')}
    ${block('function selectOption(', '/** One row of an inset group')}
    ${block('const SVG_NS =', 'function showView(')}
    ${block('function claudeSelect(', '$("#slots-add")')}
    ${block('function updateSlotSummary(', '// ---- Providers')}
    ${block('function modChanges(', '/** Take the router')}
    ${block('let modalCleanup =', 'function openClaudeAccountConsent(')}
    ${block('const MODEL_SLOTS =', 'function clientPickerSelections(')}
    ${block('async function toggleWorkerTools(', 'async function renderCodexClient(')}
    const renderClients = () => {};
    let status = { providers: {} };
    const providersOffering = () => ['p'];
    return { loadSlots, saveSlots, scheduleSlotsSave, slotRow, toggleWorkerTools, saveModelSlots,
      configRequest, toast, showModal, closeModal, setStatus: value => {status = value;},
      current: () => currentConfig };
  `)(
    { querySelectorAll: queryAll, querySelector: (s: string) => queryAll(s)[0] ?? null,
      createElement: (tag: string) => new DomNode(tag.toUpperCase()), createElementNS: (_ns: string, tag: string) => new DomNode(tag.toUpperCase()),
      createTextNode: (text: string) => { const node = new DomNode('#TEXT'); node.textContent = text; return node; } },
    { addEventListener: (name: string, fn: (event: KeyEvent) => void) => { assert.equal(name, 'keydown'); keyboard = fn; } },
    DomNode, fetchMock,
    (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    (id: number) => { timers.delete(id); },
  ) as {
    loadSlots(): Promise<void>; saveSlots(): Promise<void>; scheduleSlotsSave(): void;
    slotRow(id: string, route: Route | null): DomNode;
    toggleWorkerTools(on: boolean): Promise<void>; saveModelSlots(): Promise<void>;
    configRequest(next: Config): Promise<unknown>; toast(message: string, error?: boolean): void;
    showModal(content: DomNode): void; closeModal(): void; setStatus(value: unknown): void; current(): Config;
  };
  await ui.loadSlots();
  const row = (id: string) => { const found = nodes['slots-list']!.children.find(node => node.querySelectorAll('select')[0]?.value === id); assert.ok(found, id); return found; };
  const select = (id: string, index: number) => row(id).querySelectorAll('select')[index]!;
  const edit = (id: string, model: string) => { const control = select(id, 1); control.value = model ? JSON.stringify(['p', model]) : ''; control.emit('change'); };
  const toastText = () => nodes.toast!.children.map(node => node.textContent).join('\n');
  return { h, ui, nodes, row, select, edit, toastText, key: (event: KeyEvent) => keyboard(event), timers };
}

test('saving A preserves a remote B edit and newly added C before the latest GET, without a 409', async () => {
  const view = await harness();
  view.edit('a', 'three');
  view.h.latest.routes.b!.model = 'three';
  view.h.latest.routes.c = { provider: 'p', model: 'two', effort: 'low' };
  view.h.latest.configRevision = 'remote';
  await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 1);
  assert.equal(view.h.latest.routes.a!.model, 'three');
  assert.equal(view.h.latest.routes.b!.model, 'three');
  assert.equal(view.h.latest.routes.c!.model, 'two');
  // Saving again from the still-open, older screen must not turn preserved remote values into edits.
  view.select('a', 2).value = 'low'; await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.b!.model, 'three');
  assert.equal(view.h.latest.routes.c!.model, 'two');
});

test('an untouched remote deletion stays deleted; explicit deletion and same-row edits win locally', async () => {
  const view = await harness();
  delete view.h.latest.routes.b;
  view.h.latest.routes.a = { provider: 'p', model: 'two', effort: 'low', contextWindow: 654321, fallbacks: [] };
  view.edit('a', 'three'); await view.ui.saveSlots();
  assert.deepEqual(view.h.latest.routes.a, { provider: 'p', model: 'three', effort: 'high', contextWindow: 654321, fallbacks: [] });
  assert.equal(view.h.latest.routes.b, undefined);
  view.h.latest.routes.a!.model = 'one';
  view.row('a').querySelector('button')!.click(); await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.a, undefined);
});

test('409 retry reapplies a complete edited row after remote deletion, preserving other rows and latest metadata', async () => {
  const view = await harness(); view.edit('a', 'three');
  view.h.beforePut = async () => {
    view.h.beforePut = null;
    delete view.h.latest.routes.a;
    view.h.latest.routes.b!.contextWindow = 777777;
    view.h.latest.routes.c = { provider: 'p', model: 'one' };
    view.h.latest.configRevision = 'conflict';
  };
  await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 2);
  assert.deepEqual(view.h.latest.routes.a, { provider: 'p', model: 'three', effort: 'high' });
  assert.equal(view.h.latest.routes.b!.contextWindow, 777777);
  assert.equal(view.h.latest.routes.c!.model, 'one');
});

test('a local deletion remains a deletion through a 409 and does not remove remotely added C', async () => {
  const view = await harness(); view.edit('a', '');
  view.h.beforePut = async () => {
    view.h.beforePut = null;
    view.h.latest.routes.a!.model = 'two'; view.h.latest.routes.c = { provider: 'p', model: 'one' };
    view.h.latest.configRevision = 'conflict';
  };
  await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 2);
  assert.equal(view.h.latest.routes.a, undefined);
  assert.equal(view.h.latest.routes.c!.model, 'one');
});

for (const phase of ['beforeRead', 'beforePut'] as const) test(`edits during ${phase} are saved next, not acknowledged by the older save`, async () => {
  const view = await harness(), pending = deferred(), entered = deferred();
  view.edit('a', 'two');
  view.h[phase] = async () => { view.h[phase] = null; entered.resolve(); await pending.promise; };
  const saving = view.ui.saveSlots(); await entered.promise;
  view.edit('a', 'three'); pending.resolve(); await saving;
  assert.equal(view.h.writes.length, 2);
  assert.equal(view.h.writes[0]!.routes.a!.model, 'two');
  assert.equal(view.h.writes[1]!.routes.a!.model, 'three');
});

test('failed reads never PUT stale routes, and failed writes keep the unsaved edits for retry', async () => {
  const view = await harness(); view.edit('a', 'three');
  view.h.failRead = true; await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 0);
  assert.match(view.nodes['slots-status']!.textContent, /common.saveFailed/);
  view.h.failRead = false; view.h.failPut = true; await view.ui.saveSlots();
  assert.match(view.nodes['slots-status']!.textContent, /common.saveFailed/);
  view.h.failPut = false; view.h.latest.routes.b!.model = 'three'; await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.a!.model, 'three');
  assert.equal(view.h.latest.routes.b!.model, 'three');
});

test('a mapping without effort follows the app on screen and after a model edit is saved', async () => {
  const config = fixture(); delete config.routes.a!.effort;
  const view = await harness(config);
  const effort = view.select('a', 2);
  assert.equal(effort.value, '');
  assert.equal(effort.disabled, false);
  assert.equal(effort.children[0]!.value, '');
  assert.equal(effort.children[0]!.children[0]!.textContent, 'slots.effortFromApp');
  assert.equal(view.nodes['slots-summary']!.textContent, 'a → one · b → two (high)');
  view.edit('a', 'three'); await view.ui.saveSlots();
  assert.equal(Object.hasOwn(view.h.latest.routes.a!, 'effort'), false);
});

test('choosing the app effort removes a saved override and its summary suffix', async () => {
  const view = await harness();
  view.select('a', 2).value = ''; view.select('a', 2).emit('change');
  await view.ui.saveSlots();
  assert.equal(Object.hasOwn(view.h.latest.routes.a!, 'effort'), false);
  assert.equal(view.nodes['slots-summary']!.textContent, 'a → one · b → two (high)');
});

test('an added mapping follows the app when its target is selected', async () => {
  const view = await harness();
  view.row('c').remove();
  const row = view.ui.slotRow('c', null); view.nodes['slots-list']!.appendChild(row);
  assert.equal(view.select('c', 2).value, '');
  assert.equal(view.select('c', 2).disabled, true);
  view.edit('c', 'one');
  assert.equal(view.select('c', 2).value, '');
  assert.equal(view.select('c', 2).disabled, false);
  await view.ui.saveSlots();
  assert.deepEqual(view.h.latest.routes.c, { provider: 'p', model: 'one' });
});

test('changing targets keeps supported efforts or the app choice, never a different level', async () => {
  const config = fixture(); config.providers.p!.models[2]!.effortLevels = ['low'];
  const view = await harness(config);
  view.edit('a', 'two'); assert.equal(view.select('a', 2).value, 'high');
  view.edit('a', 'three'); assert.equal(view.select('a', 2).value, '');
  view.edit('a', 'one'); assert.equal(view.select('a', 2).value, '');
  await view.ui.saveSlots();
  assert.equal(Object.hasOwn(view.h.latest.routes.a!, 'effort'), false);
});

test('a saved unlisted effort is shown on first draw and survives a save', async () => {
  const config = fixture(); config.routes.a!.effort = 'max';
  const view = await harness(config);
  assert.equal(view.select('a', 2).value, 'max');
  assert.equal(view.select('a', 2).disabled, false);
  view.row('c').remove(); view.select('a', 0).value = 'c'; await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.c!.effort, 'max');
  assert.equal(view.h.latest.routes.a, undefined);
});

test('a target without an effort ladder keeps its muted, disabled effort cell', async () => {
  const config = fixture(); config.providers.p!.models[0]!.effortLevels = [];
  const view = await harness(config);
  const effort = view.select('a', 2), cell = effort.parent!;
  assert.equal(effort.disabled, true);
  assert.equal(cell.classes.has('muted-cell'), true);
  assert.equal((cell as DomNode & { title: string }).title, 'slots.noEffort');
  view.row('c').remove(); view.select('a', 0).value = 'c'; await view.ui.saveSlots();
  assert.equal(Object.hasOwn(view.h.latest.routes.c!, 'effort'), false);
});

test('unavailable targets and unset efforts on untouched rows are not silently rewritten', async () => {
  const config = fixture(); config.routes.b!.model = 'unlisted'; delete config.routes.a!.effort;
  const view = await harness(config); view.edit('c', 'three'); await view.ui.saveSlots();
  assert.deepEqual(view.h.latest.routes.a, config.routes.a);
  assert.deepEqual(view.h.latest.routes.b, config.routes.b);
});

test('unlisted source and target models remain identifiable and can be explicitly removed', async () => {
  const initial = fixture(); initial.routes.retired = { provider: 'missing', model: 'unlisted', effort: 'high' };
  const view = await harness(initial);
  assert.equal(view.select('retired', 1).value, JSON.stringify(['missing', 'unlisted']));
  view.row('retired').querySelector('button')!.click(); await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.retired, undefined);
  assert.deepEqual(view.h.latest.routes.a, initial.routes.a);
});

test('a catalogue refresh on another screen does not turn untouched controls into local edits', async () => {
  const view = await harness();
  view.h.latest.routes.b!.model = 'three';
  for (const model of view.h.latest.providers.p!.models) model.effortLevels = [];
  await view.ui.toggleWorkerTools(true); // Refresh currentConfig without redrawing the mapping editor.
  view.edit('c', 'three'); await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.b!.model, 'three');
  assert.equal(view.h.latest.routes.a!.effort, 'high');
  assert.deepEqual(view.h.latest.routes.c, { provider: 'p', model: 'three' });
});

test('duplicate source validation stops before any GET or PUT', async () => {
  const view = await harness(); view.select('a', 0).value = 'b'; await view.ui.saveSlots();
  assert.equal(view.h.reads, 1);
  assert.equal(view.h.writes.length, 0);
  assert.match(view.nodes['slots-status']!.textContent, /slots.duplicate/);
});

test('partial config success keeps the server warning instead of the caller success toast', async () => {
  const view = await harness(); view.h.warning = 'settings sync failed';
  await view.ui.toggleWorkerTools(true);
  assert.equal(view.toastText(), 'settings sync failed');
  assert.equal(view.nodes.toast!.classes.has('error'), true);
  assert.equal(view.ui.current().cli?.models, undefined);
  view.edit('a', 'three'); await view.ui.saveSlots();
  assert.equal(view.nodes['slots-status']!.textContent, 'settings sync failed');
  assert.equal(view.nodes['slots-status']!.classes.has('bad-text'), true);
});

test('model-slot save retains both server and search-capability warnings in one error toast', async () => {
  const view = await harness(); view.h.warning = 'settings sync failed';
  for (const [slot, value] of [['smallFast', 'one'], ['subagent', ''], ['main', '']]) {
    const select = new DomNode('SELECT'), option = new DomNode('OPTION');
    select.dataset.slot = slot!; option.value = value!; select.append(option); select.value = value!;
    view.nodes['client-model-slots']!.append(select);
  }
  view.ui.setStatus({ providers: { p: { webSearch: false } } });
  await view.ui.saveModelSlots();
  assert.equal(view.toastText(), 'settings sync failed\nslots.noWebSearchWarn');
  assert.equal(view.nodes.toast!.classes.has('error'), true);
  assert.deepEqual(view.ui.current().cli?.models, { smallFast: 'one', subagent: '', main: '' });
});

test('legacy routers still receive raw configs merged over the fresh GET', async () => {
  const initial = fixture(); delete initial.configRevision;
  const view = await harness(initial); view.edit('a', 'three');
  view.h.latest.routes.c = { provider: 'p', model: 'two' }; await view.ui.saveSlots();
  assert.equal(Object.hasOwn(view.h.writes[0]!, 'configRevision'), false);
  assert.equal(view.h.latest.routes.a!.model, 'three');
  assert.equal(view.h.latest.routes.c!.model, 'two');
});

test('three conflicts stop with a visible error and leave edits available for a later retry', async () => {
  const view = await harness(); view.edit('a', 'three');
  view.h.beforePut = async () => { view.h.latest.configRevision = `remote-${view.h.writes.length}`; };
  await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 3);
  assert.match(view.nodes['slots-status']!.textContent, /common.saveFailed/);
  assert.equal(view.h.latest.routes.a!.model, 'one');
  view.h.beforePut = null; await view.ui.saveSlots();
  assert.equal(view.h.latest.routes.a!.model, 'three');
});

test('a changed row clears obsolete effort but keeps newly read metadata through a conflict', async () => {
  const initial = fixture(); initial.providers.p!.models.push({ id: 'no-effort', effortLevels: [] });
  const view = await harness(initial); view.edit('a', 'no-effort');
  view.h.beforePut = async () => {
    view.h.beforePut = null; view.h.latest.routes.a!.contextWindow = 987654;
    view.h.latest.routes.a!.fallbacks = [{ provider: 'p', model: 'two' }]; view.h.latest.configRevision = 'conflict';
  };
  await view.ui.saveSlots();
  assert.equal(view.h.writes.length, 2);
  assert.deepEqual(view.h.latest.routes.a, { provider: 'p', model: 'no-effort', contextWindow: 987654, fallbacks: [{ provider: 'p', model: 'two' }] });
});

test('ordinary success and total failure remain distinguishable from partial success', async () => {
  const view = await harness(); await view.ui.toggleWorkerTools(true);
  assert.equal(view.toastText(), 'common.saved');
  assert.equal(view.nodes.toast!.classes.has('error'), false);
  view.h.failPut = true; await view.ui.toggleWorkerTools(false);
  assert.match(view.toastText(), /common.saveFailed/);
  assert.equal(view.nodes.toast!.classes.has('error'), true);
});

async function modal() {
  const view = await harness();
  let saves = 0, cancels = 0;
  const content = new DomNode('DIV'), input = new DomNode('INPUT'), cancel = new DomNode('BUTTON'), save = new DomNode('BUTTON');
  save.attrs['data-default-action'] = ''; save.addEventListener('click', () => { saves++; });
  cancel.addEventListener('click', () => { cancels++; view.ui.closeModal(); });
  content.append(input, cancel, save); view.ui.showModal(content);
  return { ...view, input, cancel, save, content, saves: () => saves, cancels: () => cancels };
}

test('Enter on Cancel is left to its native click and cannot invoke Save', async () => {
  const view = await modal(), event = keyEvent(view.cancel); view.key(event);
  assert.equal(event.defaultPrevented, false);
  if (!event.defaultPrevented) view.cancel.click();
  assert.equal(view.saves(), 0); assert.equal(view.cancels(), 1);
  assert.equal(view.nodes['modal-backdrop']!.hidden, true);
});

for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) test(`modal shortcut ignores ${JSON.stringify(extra)}`, async () => {
  const view = await modal(); view.key(keyEvent(view.input, 'Enter', extra));
  assert.equal(view.saves(), 0);
});

test('normal text Enter invokes one default action; disabled and closed modals do nothing', async () => {
  const view = await modal(), event = keyEvent(view.input); view.key(event);
  assert.equal(event.defaultPrevented, true); assert.equal(view.saves(), 1);
  view.save.disabled = true; view.key(keyEvent(view.input)); assert.equal(view.saves(), 1);
  view.save.disabled = false; view.ui.closeModal(); view.key(keyEvent(view.input)); assert.equal(view.saves(), 1);
});

test('native controls, editable content and targets outside the modal do not invoke its default action', async () => {
  const view = await modal();
  for (const tag of ['BUTTON', 'A', 'SELECT', 'TEXTAREA', 'SUMMARY']) {
    const node = new DomNode(tag); view.content.append(node); const event = keyEvent(node); view.key(event);
    assert.equal(event.defaultPrevented, false, tag);
  }
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) {
    const node = new DomNode('INPUT'); node.attrs.type = type; view.content.append(node); view.key(keyEvent(node));
  }
  const editable = new DomNode('DIV'); editable.isContentEditable = true; view.content.append(editable); view.key(keyEvent(editable));
  view.key(keyEvent(new DomNode('INPUT')));
  assert.equal(view.saves(), 0);
});

test('Escape during composition does not close the modal; ordinary Escape does', async () => {
  const view = await modal(); view.key(keyEvent(view.input, 'Escape', { isComposing: true }));
  assert.equal(view.nodes['modal-backdrop']!.hidden, false);
  view.key(keyEvent(view.input, 'Escape')); assert.equal(view.nodes['modal-backdrop']!.hidden, true);
});

test('the current Claude card uses the pool pause controls without rename, remove or a paused preference', async () => {
  const writes: { url: string; method: string; body: string }[] = [];
  let refreshed = 0;
  const render = new Function('document', 'Node', 'api', 'refreshClaudeAccountPanel', `
    const t = key => key, providerDetailGeneration = 1;
    const toast = () => {}, anthropicSourceText = source => source, chatgptQuotaText = () => '';
    const hint = text => el('span', {text});
    ${block('function $(', '// Inside the ClaudeRipple app')}
    ${block('function claudeAccountLabel(', 'const accountRowsDrawn =')}
    ${block('function durationText(', 'async function patchChatgptAccount(')}
    return renderClaudeAccountRows;
  `)(
    { createElement: (tag: string) => new DomNode(tag.toUpperCase()), querySelector: () => null }, DomNode,
    async (url: string, options: { method: string; body: string }) => { writes.push({ url, ...options }); },
    async () => { refreshed++; },
  ) as (target: DomNode, data: unknown, name: string, generation: number) => void;
  const stored = { id: 'stored', label: 'Personal', preferred: true, state: 'ready', expiresAt: Date.now() + 3_600_000 };
  for (const paused of [false, true]) {
    const target = new DomNode('DIV');
    render(target, { current: { id: 'current', external: true, paused, state: paused ? 'paused' : 'ready' }, accounts: [stored] }, 'claude', 1);
    const current = target.children.find(node => node.matches('.current'))!;
    assert.ok(current);
    const buttons = current.querySelectorAll('button');
    const pause = buttons.find(node => node.textContent === (paused ? 'providers.chatgptResume' : 'providers.chatgptPause'))!;
    assert.ok(pause, 'the current login always offers pause or resume');
    assert.deepEqual(buttons.map(node => node.textContent), paused ? ['providers.chatgptResume', 'resets.action'] : ['providers.preferAction', 'providers.chatgptPause', 'resets.action']);
    assert.equal(current.descendants().some(node => node.textContent === 'providers.chatgptPaused'), paused);
    assert.equal(current.descendants().some(node => node.textContent === 'providers.preferBadge'), false);
    assert.ok(current.descendants().some(node => node.textContent === 'providers.currentAccountHelp'));
    await pause.listeners.get('click')![0]!(keyEvent(pause));
    assert.deepEqual(writes.at(-1), { url: '/api/claude-accounts/current', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !paused }) });
    assert.equal(pause.disabled, false);
    const own = target.children.find(node => node !== current)!;
    assert.deepEqual(own.querySelectorAll('button').map(node => node.textContent), ['providers.preferClear', 'providers.chatgptPause', 'resets.action', 'common.edit', 'common.remove']);
  }
  assert.equal(refreshed, 2);
});

test('reset availability is read before opening, and a use needs explicit confirmation', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const toasts: string[] = [];
  let modal: DomNode | null = null;
  const modalContent = () => { assert.ok(modal); return modal; };
  const grant = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: `Reset ${id}`, left: 1, total: 1, endsAt: '2099-12-10T22:00:00+00:00', clears: ['five_hour', 'seven_day'], paused: false, usableNow: true, ...extra });
  const status = { previewId: 'a'.repeat(64), grants: [grant('usable', { percentUsed: { five_hour: 42 } }), grant('spent', { left: 0, usableNow: false })] };
  const fableOnly = { grants: [grant('fable', {
    clears: ['seven_day_overage_included', 'seven_day_cowork'], givesBackWeekly: true, percentUsed: { seven_day_overage_included: 94, seven_day: 72.5 },
  })] };
  const after = { grants: [grant('usable', { left: 0, usableNow: false })] };
  const api = async (url: string, options?: { method?: string; body?: string }) => {
    calls.push({ url, method: options?.method ?? 'GET', ...(options?.body ? { body: options.body } : {}) });
    if (url.includes('/unreadable/') || url.endsWith('?refresh=1')) throw new Error('unreadable');
    if (url.includes('/empty/')) return { status: { grants: [] } };
    if (url.includes('/not-usable/')) return { status: { grants: [
      grant('paused', { paused: true }), grant('expired', { endsAt: '2000-01-01T00:00:00Z' }), grant('not-limited', { usableNow: false }),
    ] } };
    if (url.includes('/spent/')) return { status: after };
    if (url.includes('/fable/')) return { status: fableOnly };
    if (url.includes('/lost/') && options?.method === 'POST') throw new Error('connection closed');
    return options?.method === 'POST' ? { claim: { result: 'reset', resetsLeft: 0 }, status: after } : { status };
  };
  const make = new Function('document', 'Node', 'api', 'refreshClaudeAccountPanel', 'showModal', 'closeModal', 'toast', `
    const t = (key, vars) => vars ? key + JSON.stringify(vars) : key, CURRENT_LANG = 'en';
    const hint = text => el('span', {text});
    ${block('function $(', '// Inside the ClaudeRipple app')}
    ${block('function durationText(', 'async function patchChatgptAccount(')}
    ${block('const claudeResetsState =', 'function accountPoolActions(')}
    return { claudeResetsControl, refreshClaudeResetsControls };
  `);
  let refreshed = 0;
  const { claudeResetsControl, refreshClaudeResetsControls } = make(
    { createElement: (tag: string) => new DomNode(tag.toUpperCase()), querySelector: () => null }, DomNode,
    api, async () => { refreshed++; }, (content: DomNode) => { modal = content; }, () => { modal = null; }, (message: string) => toasts.push(message),
  ) as {
    claudeResetsControl: (provider: string, id: string, label: string, needsLogin?: boolean) => { button: DomNode; panel: DomNode };
    refreshClaudeResetsControls: (target: DomNode) => void;
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const { button, panel } = claudeResetsControl('claude', 'acct', 'Emilie');
  const target = new DomNode('DIV');
  target.append(button, panel);
  assert.equal(panel.hidden, true, 'closed until asked for');
  assert.equal(button.disabled, true, 'unknown availability cannot be opened');
  refreshClaudeResetsControls(target);
  refreshClaudeResetsControls(target);
  await flush();
  assert.equal(button.disabled, false);
  assert.deepEqual(calls, [{ url: '/api/claude-accounts/acct/resets', method: 'GET' }], 'prefetch once without forcing it');
  button.click();
  assert.equal(panel.hidden, false);
  const uses = panel.querySelectorAll('button').filter(node => node.textContent === 'resets.use');
  assert.deepEqual(uses.map(node => node.disabled), [false], 'a spent grant is not listed');

  uses[0]!.emit('click'); await flush();
  assert.ok(modalContent().descendants().some(node => node.textContent.includes('Emilie') && node.textContent.includes('Reset usable')));
  assert.deepEqual(modalContent().querySelectorAll('li').map(node => node.textContent), ['resets.window.five_hour: 42% → 0%', 'resets.window.seven_day: common.notAvailable → 0%']);
  assert.equal(calls.length, 1, 'opening the modal sends nothing');
  modalContent().querySelectorAll('button').find(node => node.textContent === 'common.cancel')!.emit('click');
  assert.equal(modal, null);
  assert.equal(calls.length, 1, 'cancelling sends nothing');

  uses[0]!.emit('click');
  modalContent().querySelectorAll('button').find(node => node.textContent === 'resets.use')!.emit('click'); await flush();
  const posts = calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts, [{ url: '/api/claude-accounts/acct/resets', method: 'POST', body: JSON.stringify({ grantId: 'usable', previewId: status.previewId, confirm: true }) }]);
  assert.equal(refreshed, 1, 'the account list is read again after a reset');
  assert.deepEqual(toasts, ['resets.result.reset{"left":0}']);
  assert.deepEqual(panel.querySelectorAll('button').filter(node => node.textContent === 'resets.use').map(node => node.disabled), [], 'the used grant leaves the list');

  assert.equal(button.disabled, true, 'the last use disables the button');
  assert.equal(panel.hidden, true, 'the empty list closes');
  refreshClaudeResetsControls(target);
  assert.equal(calls.filter(call => call.method === 'GET').length, 1, 'account polling reuses recent availability');

  const unavailable = [
    ['empty', 'resets.none'], ['spent', 'resets.none'], ['not-usable', 'resets.notUsable'],
    ['unreadable', 'resets.unavailable'], ['login', 'resets.needsLogin'],
  ] as const;
  const controls = unavailable.map(([id]) => claudeResetsControl('claude', id, id, id === 'login'));
  const readable = claudeResetsControl('claude', 'readable', 'Readable');
  target.append(...controls.flatMap(({ button, panel }) => [button, panel]), readable.button, readable.panel);
  refreshClaudeResetsControls(target);
  await flush();
  assert.equal(calls.some(call => call.url.includes('/login/')), false, 'do not look up an account known to need sign-in');
  for (const [i, [, title]] of unavailable.entries()) {
    const control = controls[i]!;
    assert.equal(control.button.disabled, true, title);
    assert.equal(control.button.attrs.title, title);
    control.button.click();
    assert.equal(control.panel.hidden, true, title);
  }
  readable.button.click();
  readable.panel.querySelectorAll('button').find(node => node.textContent === 'resets.refresh')!.click();
  await flush();
  assert.equal(readable.button.disabled, false, 'the open panel remains recoverable after a failed refresh');
  assert.equal(readable.button.attrs.title, 'resets.unavailable');
  assert.equal(readable.panel.hidden, false);
  assert.equal(readable.panel.querySelectorAll('button').some(node => node.textContent === 'resets.use'), false);

  const fable = claudeResetsControl('claude', 'fable', 'Fable');
  target.append(fable.button, fable.panel);
  refreshClaudeResetsControls(target);
  await flush();
  fable.button.click();
  assert.ok(fable.panel.descendants().some(node => node.textContent === 'resets.fableGiveback'));
  fable.panel.querySelectorAll('button').find(node => node.textContent === 'resets.use')!.click();
  assert.deepEqual(modalContent().querySelectorAll('li').map(node => node.textContent), [
    'resets.window.seven_day_fable: 94% → 0%',
    'seven_day_cowork: common.notAvailable → 0%',
    'resets.window.seven_day: 72.5% · resets.fableGiveback',
  ]);
  assert.deepEqual(calls.filter(call => call.method === 'POST'), posts, 'previewing Fable does not redeem it');

  const lost = claudeResetsControl('claude', 'lost', 'Lost response');
  target.append(lost.button, lost.panel);
  refreshClaudeResetsControls(target);
  await flush();
  lost.button.click();
  lost.panel.querySelectorAll('button').find(node => node.textContent === 'resets.use')!.click();
  modalContent().querySelectorAll('button').find(node => node.textContent === 'resets.use')!.click();
  await flush();
  assert.equal(lost.panel.hidden, false);
  assert.equal(toasts.at(-1), 'resets.result.unconfirmed');
  assert.ok(lost.panel.querySelectorAll('button').some(node => node.textContent === 'resets.refresh' && !node.disabled));
  assert.equal(calls.filter(call => call.url.includes('/lost/')).length, 2, 'no automatic retry');
});

test('the dashboard recognises Ollama so an empty ladder there is measured, not a decision', () => {
  const isOllama = new Function(`${block('function isOllamaProvider', 'async function startMeasurement')}\nreturn isOllamaProvider;`)() as (provider: unknown) => boolean;
  for (const provider of [{ preset: 'ollama' }, { url: 'https://ollama.com/v1' }, { url: 'https://ollama.com' }, { url: 'http://127.0.0.1:11434/v1' }, { url: 'http://localhost:11434' }]) {
    assert.equal(isOllama(provider), true, JSON.stringify(provider));
  }
  for (const provider of [undefined, {}, { url: '' }, { url: 'https://api.deepseek.com/v1' }, { url: 'https://notollama.com/v1' }, { url: 'http://127.0.0.1:8080/v1' }]) {
    assert.equal(isOllama(provider), false, JSON.stringify(provider));
  }
});
