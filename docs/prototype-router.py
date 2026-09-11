#!/usr/bin/env python3
"""claude-router: local HTTPS proxy that lets the 1P Claude Desktop app (and any
Claude Code CLI) route selected model names to proxenos (GPT) while passing
everything else to api.anthropic.com untouched.

How it is wired:
  ~/.claude/settings.json  env.HTTPS_PROXY        = http://127.0.0.1:8790
                           env.NODE_EXTRA_CA_CERTS = <this dir>/ca.pem
  CONNECT api.anthropic.com  -> TLS terminated here (leaf.pem) -> per-request:
      model in triggers.json -> model rewritten, sent to proxenos (plain HTTP)
      otherwise              -> forwarded byte-for-byte to api.anthropic.com
  CONNECT anything else      -> blind tunnel
"""
import asyncio, json, os, re, ssl, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
LISTEN = ("127.0.0.1", 8790)
PROXENOS = ("127.0.0.1", 8787)
UPSTREAM = "api.anthropic.com"
LEAF = (os.path.join(HERE, "leaf.pem"), os.path.join(HERE, "leaf.key"))
TRIGGERS_FILE = os.path.join(HERE, "triggers.json")
EFFORT_CLAMP = {"ultra": "max"}          # proxenos/OpenAI reject 'ultra'

_triggers = {}
_triggers_mtime = 0.0


def triggers():
    """{"claude-sonnet-4-6": "gpt-5.6-terra", ...}; hot-reloaded on file change."""
    global _triggers, _triggers_mtime
    try:
        m = os.stat(TRIGGERS_FILE).st_mtime
        if m != _triggers_mtime:
            with open(TRIGGERS_FILE) as f:
                _triggers = json.load(f)
            _triggers_mtime = m
            log(f"triggers loaded: {_triggers}")
    except FileNotFoundError:
        _triggers = {}
    return _triggers


SHORT_NAMES = {"luna": "gpt-5.6-luna", "terra": "gpt-5.6-terra", "sol": "gpt-5.6-sol", "astra": "gpt-6-astra"}
REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
MARKER = re.compile(r"\[\[\s*gpt\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]")


def marker_override(j):
    """A subagent prompt may start with '[[gpt: sol@xhigh]]' to pick model/effort at call time.
    Scanned in the first user message only. Returns (model, effort) or None."""
    try:
        seen = 0
        for m in j.get("messages") or []:
            if m.get("role") != "user":
                continue
            seen += 1
            if seen > 5:            # the task prompt is always near the top
                break
            c = m.get("content")
            text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            # drop injected <system-reminder> blocks (CLAUDE.md lives there and quotes the marker syntax)
            text = REMINDER.sub("", text)
            if os.environ.get("ROUTER_DEBUG") or os.path.exists(os.path.join(HERE, "DEBUG")):
                log(f"marker scan user#{seen}: {text[:200]!r}")
            hit = MARKER.search(text)
            if hit:
                name, eff = hit.group(1).lower(), (hit.group(2) or "").lower() or None
                return SHORT_NAMES.get(name, name), eff
    except Exception as e:
        log("marker scan error", repr(e))
    return None


def resolve(model, j=None):
    """Decide whether a request model goes to proxenos.
    Returns (gpt_model, effort_or_None) or None for Anthropic passthrough.
      - 'gpt-5.6-sol'          -> proxenos as-is (raw GPT ids from agent frontmatter / --model)
      - 'gpt-5.6-sol@medium'   -> proxenos, effort forced to medium
      - '[[gpt: luna@max]]' at the start of the task prompt overrides both (gpt-* models only)
      - trigger alias (triggers.json): value is a string or {"model": ..., "effort": ...}
    """
    if not isinstance(model, str):
        return None
    effort = None
    base = model
    if "@" in model:
        base, effort = model.split("@", 1)
    if base.startswith("gpt-"):
        ov = marker_override(j) if j is not None else None
        if ov:
            base, effort = ov[0], ov[1] or effort
        return base, effort
    t = triggers().get(base)
    if t is None:
        return None
    if isinstance(t, dict):
        return t["model"], effort or t.get("effort")
    return t, effort


def log(*a):
    print(time.strftime("%m-%d %H:%M:%S"), *a, flush=True)


async def read_head(r):
    head = await r.readuntil(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    req = lines[0].decode()
    hdrs = {}
    for l in lines[1:]:
        if b":" in l:
            k, v = l.split(b":", 1)
            hdrs[k.strip().decode().lower()] = v.strip().decode()
    return req, hdrs


async def read_body(r, hdrs):
    if "content-length" in hdrs:
        return await r.readexactly(int(hdrs["content-length"]))
    if hdrs.get("transfer-encoding", "").lower() == "chunked":
        out = b""
        while True:
            line = await r.readuntil(b"\r\n")
            n = int(line.strip().split(b";")[0], 16)
            if n == 0:
                await r.readuntil(b"\r\n")
                return out
            out += await r.readexactly(n)
            await r.readuntil(b"\r\n")
    return b""


def rebuild(req, hdrs, body, host):
    h = dict(hdrs)
    h["host"] = host
    h["content-length"] = str(len(body))
    h["connection"] = "close"
    h.pop("transfer-encoding", None)
    return req.encode() + b"\r\n" + b"".join(f"{k}: {v}\r\n".encode() for k, v in h.items()) + b"\r\n" + body


async def relay(ur, w):
    """Copy the upstream response raw until upstream closes (we asked Connection: close).
    Returns (status_line, bytes)."""
    total = 0
    status = "?"
    first = True
    while True:
        d = await ur.read(65536)
        if not d:
            break
        if first:
            status = d.split(b"\r\n", 1)[0].decode(errors="replace")
            first = False
        total += len(d)
        w.write(d)
        await w.drain()
    return status, total


BOOTSTRAP_PATH = "/api/claude_cli/bootstrap"
MODELS_FILE = os.path.join(HERE, "models.json")


def picker_models():
    try:
        with open(MODELS_FILE) as f:
            return json.load(f)
    except Exception as e:
        log("models.json unreadable:", repr(e))
        return {}


async def relay_bootstrap(ur, w):
    """Buffer the (small, JSON) bootstrap response and inject GPT entries into
    additional_model_options (feeds the model picker) and auto_compact_windows."""
    raw = b""
    while True:
        d = await ur.read(65536)
        if not d:
            break
        raw += d
    head, _, body = raw.partition(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    try:
        hl = [l for l in head.split(b"\r\n")]
        hdrs = {}
        for l in hl[1:]:
            if b":" in l:
                k, v = l.split(b":", 1)
                hdrs[k.strip().decode().lower()] = v.strip().decode()
        if hdrs.get("transfer-encoding", "").lower() == "chunked":
            out = b""
            rest = body
            while True:
                line, _, rest = rest.partition(b"\r\n")
                n = int(line.strip().split(b";")[0], 16)
                if n == 0:
                    break
                out += rest[:n]
                rest = rest[n + 2:]
            body = out
        j = json.loads(body)
        cfg = picker_models()
        picker = cfg.get("picker") or []
        if picker:
            j["additional_model_options"] = (j.get("additional_model_options") or []) + picker
        win = cfg.get("auto_compact_window")
        if win:
            acw = dict(j.get("auto_compact_windows") or {})
            for m in picker:
                acw[m["model"]] = win
            for alias in triggers():          # app-picker aliases that route to GPT
                acw[alias] = win
            j["auto_compact_windows"] = acw
        nb = json.dumps(j).encode()
        keep = [hl[0]] + [l for l in hl[1:] if not l.lower().startswith((b"content-length:", b"transfer-encoding:", b"content-encoding:"))]
        out = b"\r\n".join(keep) + f"\r\ncontent-length: {len(nb)}\r\n\r\n".encode() + nb
        w.write(out)
        await w.drain()
        log(f"bootstrap: injected {len(picker)} picker models")
        return status, len(out)
    except Exception as e:
        log("bootstrap inject failed, passing raw:", repr(e))
        w.write(raw)
        await w.drain()
        return status, len(raw)


async def serve_api(r, w, peer):
    """r/w are TLS-terminated as api.anthropic.com; serve requests until the client closes."""
    while True:
        try:
            req, hdrs = await read_head(r)
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.LimitOverrunError):
            return
        body = await read_body(r, hdrs)
        method, path, _ = req.split(" ", 2)
        model = None
        j = None
        if body and hdrs.get("content-type", "").startswith("application/json"):
            try:
                j = json.loads(body)
                model = j.get("model")
            except Exception:
                j = None
        t0 = time.time()
        try:
            route = resolve(model, j) if j is not None else None
            if route is not None:
                gpt_model, effort = route
                j["model"] = gpt_model
                oc = j.get("output_config") or {}
                if effort:
                    oc["effort"] = effort
                if oc.get("effort") in EFFORT_CLAMP:
                    oc["effort"] = EFFORT_CLAMP[oc["effort"]]
                if oc:
                    j["output_config"] = oc
                nb = json.dumps(j).encode()
                tag = f"GPT  {model}->{gpt_model} effort={oc.get('effort')}"
                ur, uw = await asyncio.open_connection(*PROXENOS)
                uw.write(rebuild(req, hdrs, nb, f"{PROXENOS[0]}:{PROXENOS[1]}"))
            else:
                tag = f"PASS {model}"
                ctx = ssl.create_default_context()
                ur, uw = await asyncio.open_connection(UPSTREAM, 443, ssl=ctx, server_hostname=UPSTREAM)
                if path.startswith(BOOTSTRAP_PATH):
                    hdrs = dict(hdrs)
                    hdrs.pop("accept-encoding", None)   # need a plain body to edit
                uw.write(rebuild(req, hdrs, body, UPSTREAM))
            await uw.drain()
            if path.startswith(BOOTSTRAP_PATH) and route is None:
                status, n = await relay_bootstrap(ur, w)
            else:
                status, n = await relay(ur, w)
            uw.close()
            log(f"{tag} {method} {path} req={len(body)}B -> {status} {n}B {time.time()-t0:.1f}s")
        except (ConnectionError, asyncio.CancelledError) as e:
            log(f"{tag} {method} {path} aborted: {e!r}")
            return
        except Exception as e:
            log(f"{tag} {method} {path} error: {e!r}")
            try:
                w.write(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                await w.drain()
            except Exception:
                pass
            return


async def tunnel(r, w, host, port):
    ur, uw = await asyncio.open_connection(host, port)

    async def pipe(a, b):
        try:
            while True:
                d = await a.read(65536)
                if not d:
                    break
                b.write(d)
                await b.drain()
        except Exception:
            pass
        finally:
            try:
                b.close()
            except Exception:
                pass

    await asyncio.gather(pipe(r, uw), pipe(ur, w))


async def start_tls_server_side(w, ctx):
    """StreamWriter.start_tls() only exists in Python 3.11+; do it by hand for 3.9."""
    loop = asyncio.get_event_loop()
    tr = w.transport
    pr = tr.get_protocol()
    new = await loop.start_tls(tr, pr, ctx, server_side=True)
    w._transport = new
    pr._transport = new
    rd = getattr(pr, "_stream_reader", None)
    if rd is not None:
        rd._transport = new


SRV_CTX = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
SRV_CTX.load_cert_chain(*LEAF)
SRV_CTX.set_alpn_protocols(["http/1.1"])


CLIENT_TASKS = set()   # strong refs: asyncio may GC a pending connection task otherwise ("Task was destroyed")


async def client(r, w):
    peer = w.get_extra_info("peername")
    task = asyncio.current_task()
    CLIENT_TASKS.add(task)
    try:
        req, hdrs = await read_head(r)
        method, target, _ = req.split(" ", 2)
        if method != "CONNECT":
            w.write(b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n")
            await w.drain()
            return
        host, port = target.rsplit(":", 1)
        w.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await w.drain()
        if host == UPSTREAM:
            await start_tls_server_side(w, SRV_CTX)
            await serve_api(r, w, peer)
        else:
            await tunnel(r, w, host, int(port))
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    except Exception as e:
        log("client error", repr(e))
    finally:
        CLIENT_TASKS.discard(task)
        try:
            w.close()
        except Exception:
            pass


async def main():
    s = await asyncio.start_server(client, *LISTEN, limit=4 * 1024 * 1024)
    log(f"claude-router listening on {LISTEN[0]}:{LISTEN[1]} proxenos={PROXENOS} triggers={triggers()}")
    async with s:
        await s.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
