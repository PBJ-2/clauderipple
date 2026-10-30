// What a model/effort answer means, in the one word both receivers hang the notice on:
// `notice.settings_<outcome>` (web/i18n.ts), drawn by the timeline, the web client and the composer.
// Pure (no platform imports) so every caller reads the same answer the same way.

import type { SettingsResult } from "./protocol.ts";

/** The notice a settings answer earns. `pending` is not a failure: the host accepted the request
 *  and applies it after the running response, while `model`/`effort` above stay in force. A
 *  `partial` answer with no error text is that same acceptance from a host that predates `pending`. */
export type SettingsOutcome = "applied" | "pending" | "partial" | "unknown";

export function settingsOutcome(result: Pick<SettingsResult, "status" | "pending" | "errors">): SettingsOutcome {
  if (result.pending) return "pending";
  if (result.status === "partial") return result.errors ? "partial" : "pending";
  return result.status === "unknown" ? "unknown" : "applied";
}
