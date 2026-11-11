// A worker pinned to a stored account carries a qualified model id,
// `<provider>#<account pin>:<model>` (router targets.ts pinnedModel). People never see that id:
// the pin is a hash and the provider half is plumbing. This turns it into what the dashboard
// shows, the model's short title and the account's display name ("Opus 5.5 · mambo20211").
// No imports: the host (event log) and every client (web UI, the phone app) share it.

/** Account display names by `<provider>#<pin>`, as the host reads them from the router. */
export type AccountNames = Readonly<Record<string, string>>;

const PINNED = /^([A-Za-z0-9._-]+)#([A-Za-z0-9._-]+):(.+)$/;

/** The model's short title: Claude ids as family and version, anything else as its id. */
function modelTitle(id: string): string {
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?$/i.exec(id);
  if (claude) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1).toLowerCase();
    return claude[2] ? `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}` : family;
  }
  return id;
}

/** Whether a model id is a pinned worker's qualified id. */
export function isPinnedModelId(model: string | null | undefined): boolean {
  return typeof model === "string" && PINNED.test(model.split("@")[0]!);
}

/**
 * The name to show for a worker's model. A pinned id becomes `<model title> · <account>` (its `@effort` is left off; the card shows the effort apart); the
 * account is left out when `accounts` does not know the pin, and the pin itself is never shown. An
 * unpinned id is returned as it is. `null`/empty gives `undefined`.
 */
export function workerModelLabel(model: string | null | undefined, accounts?: AccountNames): string | undefined {
  if (typeof model !== "string" || !model) return undefined;
  const pinned = PINNED.exec(model.split("@")[0]!);
  if (!pinned) return model;
  const account = accounts?.[`${pinned[1]}#${pinned[2]}`]?.trim();
  const name = modelTitle(pinned[3]!);
  return account ? `${name} · ${account}` : name;
}
