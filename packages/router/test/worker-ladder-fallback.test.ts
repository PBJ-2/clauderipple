import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DEFAULTS, type Config } from '../src/config.ts';
import { CertStore } from '../src/certs.ts';
import { createCa } from '../src/x509.ts';
import { Proxy } from '../src/proxy.ts';
import { providerExhaustion, UpstreamHealth } from '../src/health.ts';
import { Logger } from '../src/log.ts';
import { RequestLog } from '../src/requestlog.ts';
import { workerLadderLine } from '../../mod/hooks/ladder.ts';
import { encodeEnvelope } from '../src/reasoning.ts';
import { syncAgentFiles } from '../src/agents.ts';
import { normalizeSettings } from '../../mod/hooks/settings.ts';

for (const type of ['anthropic-compatible', 'openai-compatible', 'google'] as const) {
  for (const failure of ['billing', 'deprecated', 'rate'] as const) {
    test(`${type}: running worker skips a known ${failure} target within its own ladder (#89)`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-worker-ladder-'));
      const ca = createCa({ cn: 'worker ladder test' });
      fs.writeFileSync(path.join(home, 'ca.pem'), ca.certPem);
      fs.writeFileSync(path.join(home, 'ca.key'), ca.keyPem);
      const seen: string[] = [];
      const fallbackBodies: { system?: unknown; messages?: { content?: { type?: string }[] }[] }[] = [];
      const up = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string; system?: unknown; messages?: { content?: { type?: string }[] }[] };
          const model = body.model ?? (req.url?.includes('retired') ? 'retired' : 'next');
          seen.push(model);
          if (model === 'retired') {
            res.writeHead(failure === 'deprecated' ? 410 : 429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: failure === 'deprecated' ? 'ModelDeprecated' : 'RESOURCE_EXHAUSTED', message: failure === 'billing' ? 'Your project has exceeded its monthly spending cap.' : failure === 'deprecated' ? 'Model retired has been deprecated.' : 'rate_limit_exceeded' } }));
          } else {
            // The fallback always uses the Anthropic-compatible path.
            fallbackBodies.push(body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg_ok', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'answer' }], usage: {} }));
          }
        });
      });
      await new Promise<void>(r => up.listen(0, '127.0.0.1', r));
      const port = (up.address() as net.AddressInfo).port;
      const probe = net.createServer();
      await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
      const proxyPort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>(r => probe.close(() => r()));
      const url = `http://127.0.0.1:${port}`;
      const cfg: Config = { ...DEFAULTS, listen: { host: '127.0.0.1', port: proxyPort }, routes: {}, direct: [], providers: {
        p: type === 'google' ? { type, url, auth: 'api-key', apiKey: 'test', models: [{ id: 'retired' }] } : { type, url, models: [{ id: 'retired' }] },
        q: { type: 'anthropic-compatible', url, identity: false, models: [{ id: 'next', effortLevels: ['low', 'high'] }, { id: 'retired' }] },
      } };
      syncAgentFiles(cfg, home, undefined, { manifestPath: path.join(home, 'generated-agents.json') });
      fs.writeFileSync(path.join(home, 'mod-settings.json'), JSON.stringify({ revision: 1, settings: normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { standard: [{ target: { agent: 'next' }, effort: 'low' }] } } } }) }));
      const requests = new RequestLog(path.join(home, 'requests.jsonl'));
      const proxy = new Proxy({ config: () => cfg, home, agentDir: home, log: new Logger(path.join(home, 'router.log'), 1e6, 1, false), certs: new CertStore(home), health: new UpstreamHealth(() => 100, () => {}), requests });
      await proxy.listen();
      const send = async (prompt: string, agent = 'worker-a'): Promise<number> => {
        const sock = net.connect(proxyPort, '127.0.0.1');
        await new Promise<void>(r => sock.once('connect', r));
        sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
        await new Promise<void>(r => sock.once('data', () => r()));
        const secure = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca: ca.certPem });
        await new Promise<void>(r => secure.once('secureConnect', r));
        const body = JSON.stringify({ model: 'p:retired@high', max_tokens: 16,
          system: [{ type: 'text', text: 'Stable cached prefix', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign reasoning', signature: encodeEnvelope({ w: 'chat', p: 'p', m: 'retired', f: 'reasoning_content' }) }, { type: 'text', text: 'working' }] }, { role: 'user', content: 'Continue' }],
        });
        secure.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-claude-code-session-id: session-a\r\n${agent ? `x-claude-code-agent-id: ${agent}\r\n` : ''}content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        const first = await new Promise<Buffer>(r => secure.once('data', (data: Buffer) => r(data)));
        const status = Number(/^HTTP\/1.1 (\d+)/.exec(first.toString())?.[1]);
        secure.destroy();
        return status;
      };
      const line = workerLadderLine({ pick: 'pick-a', model: 'p:retired@high', fallbacks: ['next@low'] });
      try {
        assert.equal(await send(`${line}\nTask`), failure === 'deprecated' ? (type === 'anthropic-compatible' ? 410 : 400) : 429);
        assert.equal(seen.filter(m => m === 'retired').length, 1);
        // A 429 cools the key, so the pool itself knows the primary is unusable (#164): a ladder worker
        // no longer waits on it, the same as for a declared exhaustion.
        assert.equal(await send(`${line}\nTask`), 200);
        {
          assert.equal(seen.filter(m => m === 'retired').length, 1, 'no request reaches the known unusable model');
          assert.deepEqual(fallbackBodies[0]?.system, [{ type: 'text', text: 'Stable cached prefix', cache_control: { type: 'ephemeral' } }]);
          assert.equal(fallbackBodies[0]?.messages?.flatMap(m => Array.isArray(m.content) ? m.content : []).some(b => b.type === 'thinking'), false, 'the fallback uses its own thinking sanitizer');
          assert.equal(await send('compacted task'), 200, 'agent identity retains its ladder after compaction');
          assert.equal(await send('Task', 'worker-b'), failure === 'deprecated' ? (type === 'anthropic-compatible' ? 410 : 400) : 429, 'another worker never inherits this ladder');
          assert.equal(await send(`${line}\nTask`, ''), failure === 'deprecated' ? (type === 'anthropic-compatible' ? 410 : 400) : 429, 'main-session traffic is not rerouted');
          assert.match(fs.readFileSync(path.join(home, 'router.log'), 'utf8'), failure === 'rate'
            ? /LADDER.*p\/retired.*q\/next.*provider_unusable/ : /LADDER.*p\/retired.*q\/next.*(?:billing_exhausted|model_deprecated)/);
          const record = requests.list(20).find(r => r.provider === 'q');
          assert.equal(record?.target, 'next');
          assert.equal(record?.effort, 'low');
          assert.match(record?.note ?? '', /fallback/);
          assert.equal(proxy.modelHealth.get('q', 'retired'), undefined, 'same id on a different provider remains unaffected');
          const before = seen.filter(m => m === 'next').length;
          proxy.providerHealth.observe('q', 429, providerExhaustion(429, 'insufficient_quota'));
          assert.equal(await send('compacted task'), failure === 'deprecated' ? (type === 'anthropic-compatible' ? 410 : 400) : 429, 'no usable fallback keeps the original refusal contract');
          assert.equal(seen.filter(m => m === 'next').length, before, 'an exhausted fallback is never called');
        }
      } finally {
        proxy.close();
        await new Promise<void>(r => up.close(() => r()));
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
