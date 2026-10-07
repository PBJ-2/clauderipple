// Grok on a SuperGrok / X Premium subscription: Anthropic Messages translated to OpenAI Chat
// Completions and sent to the chat proxy the Grok CLI itself talks to, signed in with the CLI's own
// session. The translation, streaming, retries and error mapping are the openai-compatible adapter's;
// what this adds is the credential, which rotates under us, and the headers the proxy routes on.
//
// The proxy is documented for direct use in the CLI's README ("Using auth.json for API Access":
// `Authorization: Bearer`, `X-XAI-Token-Auth: xai-grok-cli`, `x-grok-model-override`). Measured
// 2026-10-08 that it also refuses a request without `x-grok-client-version` (426 "Your Grok CLI
// version (none) is outdated"), which the README does not mention — see ARCHITECTURE §4e.

import type http from "node:http";
import type { GrokProvider, OpenAiCompatibleProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";
import { OpenAiCompatibleAdapter, type OpenAiOutcome } from "../openai/index.ts";
import { GROK_AUTH_HINT, GrokAuth, GrokAuthError, grokHome } from "./auth.ts";
import { GROK_DEFAULT_URL, GROK_EFFORT_LEVELS } from "./catalog.ts";

/**
 * Facts only, returned by the probe in a `warning` field like the Antigravity one. Nothing published
 * by xAI says either way whether a third-party client may use the CLI's session.
 */
export const GROK_WARNING =
  "This uses the Grok CLI's own sign-in and the chat proxy the CLI talks to. xAI's README for the CLI " +
  "shows that proxy being called directly with this session, but the version header it also requires " +
  "is undocumented and could change with any CLI release. ClaudeRipple is not affiliated with xAI.";

/** The headers the proxy authenticates and routes on. The model goes in a header, not just the body. */
export function grokHeaders(token: string, model: string, clientVersion: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-model-override": model,
    "x-grok-client-version": clientVersion,
  };
}

function bearer(headers: Record<string, string>): string {
  return (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

export class GrokAdapter {
  readonly name: string;
  readonly auth: GrokAuth;
  private readonly inner: OpenAiCompatibleAdapter;

  constructor(name: string, cfg: GrokProvider, log: Logger, auth?: GrokAuth) {
    this.name = name;
    this.auth = auth ?? new GrokAuth({
      home: cfg.home ?? grokHome(),
      ...(cfg.cli ? { cli: cfg.cli } : {}),
      ...(cfg.clientVersion ? { clientVersion: cfg.clientVersion } : {}),
      log,
    });
    // Chat Completions rather than the `responses` backend the listing names: on Chat the reasoning
    // arrives as text the mapper turns into thinking blocks, and a stable prefix was cached without a
    // conversation header (measured 2026-10-08, §4e). Effort per model comes from the listing the
    // probe saved; a model it has not described gets the common ladder.
    const translated: OpenAiCompatibleProvider = {
      type: "openai-compatible",
      url: cfg.url ?? GROK_DEFAULT_URL,
      wire: "chat",
      caps: { reasoning: "effort", effortLevels: [...GROK_EFFORT_LEVELS] },
      ...(cfg.models ? { models: cfg.models } : {}),
      ...(cfg.identity === undefined ? {} : { identity: cfg.identity }),
      ...(cfg.instructionsAppend ? { instructionsAppend: cfg.instructionsAppend } : {}),
    };
    this.inner = new OpenAiCompatibleAdapter(name, translated, log, {
      label: "Grok",
      logTag: "grok",
      authHint: GROK_AUTH_HINT,
      headers: async (model) => {
        const token = this.auth.current();
        return grokHeaders(token?.key ?? "", model, await this.auth.clientVersion());
      },
      unauthorized: async (_model, sent) => this.auth.rejected(bearer(sent)),
    });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<OpenAiOutcome> {
    // Counting tokens is answered locally and needs no session.
    if (!path.startsWith("/v1/messages/count_tokens")) {
      try {
        await this.auth.token();
      } catch (error) {
        if (!(error instanceof GrokAuthError)) throw error;
        const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: `Grok: ${error.message}` } });
        res.writeHead(401, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
        return { status: 401, bytes: Buffer.byteLength(body), note: "no usable Grok session" };
      }
    }
    return this.inner.handle(req, res, path, json, model, effort);
  }
}
