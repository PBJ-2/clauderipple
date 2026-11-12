import type { ArtifactRef } from "./protocol.ts";

const TITLE_MAX = 200;
const ICON_MAX = 64;

/**
 * The card an `Artifact` tool call leaves behind, read from the result record's `toolUseResult`
 * (`url`, `title`, `icon`, `version`, `artifact_id`). Only a published claude.ai page is a link
 * the phone may open: any other address, or a result that is not an artifact's, gives nothing.
 */
export function artifactOf(value: unknown): ArtifactRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  // WebFetch and other results carry a `url` too; only an artifact's result has an artifact id.
  if (typeof r.artifact_id !== "string" || !r.artifact_id || typeof r.url !== "string" || typeof r.title !== "string") return undefined;
  let url: URL;
  try { url = new URL(r.url); } catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname !== "claude.ai" || url.port || url.username || url.password) return undefined;
  const title = r.title.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, TITLE_MAX);
  if (!title) return undefined;
  const icon = typeof r.icon === "string" && r.icon.length <= ICON_MAX && !/[\x00-\x1f\x7f]/.test(r.icon) ? r.icon.trim() : "";
  return {
    title, url: url.href,
    ...(icon ? { icon } : {}),
    ...(typeof r.version === "number" && Number.isInteger(r.version) && r.version > 0 ? { version: r.version } : {}),
  };
}
