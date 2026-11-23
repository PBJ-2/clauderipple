// Downgrade at the connection boundary only: logs and other clients retain the full truth.
import { handoffUnavailableText } from "./handoff.ts";
import { CLIENT_FEATURES, type ClientFeature, type HostMsg, type SessionEvent, type SettingsResult } from "./protocol.ts";

export function clientFeatures(value: unknown): Set<ClientFeature> {
  return new Set(CLIENT_FEATURES.filter(feature => Array.isArray(value) && value.includes(feature)));
}

export function clientEvent(event: SessionEvent, features: ReadonlySet<ClientFeature>): SessionEvent {
  let next = event;
  if (!features.has("scopedAlways")) {
    if (event.kind === "permission") {
      const { alwaysAllow: _scope, ...card } = event;
      next = { ...card, canAlways: false };
    } else if (event.kind === "permission_decided" && event.decision === "allow_always") {
      next = { ...event, decision: "allow" };
    }
  }
  // An older app renders an unknown notice code as its key; "{text}" is the one code it can show.
  if (event.kind === "notice" && event.code === "desktop_handoff_unavailable" && !features.has("handoffUnavailableNotice")) {
    next = { ...event, code: "desktop_settings_failed", text: handoffUnavailableText() };
  }
  if (features.has("sessionFiles")) return next;
  // Message-level files come from image references, including ones without an extension or trusted MIME.
  const placeholders = (event.files ?? []).filter(file => file.status !== "ready")
    .map(() => ({ type: "image" as const, mediaType: "image/png" }));
  if (!placeholders.length) return next;
  // Replace unsupported metadata instead of inflating a page beyond the event log's frame budget.
  const { files: _files, ...legacy } = next;
  return { ...legacy, images: [...(next.images ?? []), ...placeholders] };
}

export function settingsResponse(reqId: string, result: SettingsResult, features: ReadonlySet<ClientFeature>): HostMsg {
  if (features.has("settingsResult") || result.status === "applied") return { t: "res", reqId, ok: true, data: result };
  const detail = Object.values(result.errors ?? {}).filter(Boolean).join("; ");
  const message = result.status === "partial" ? "일부 설정을 적용하지 못했습니다." : "설정 적용 여부를 확인할 수 없습니다.";
  return { t: "res", reqId, ok: false, error: detail ? `${message} ${detail}` : message };
}
