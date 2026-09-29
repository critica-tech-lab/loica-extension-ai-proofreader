/**
 * POST /api/proofread/:id/stats — record how suggestions were used.
 *
 * Body: { events: [{ lang, event, count }] }. Only counts are stored (see
 * `stats-events.ts`); unknown events and malformed rows are dropped. Needs a
 * logged-in user; anonymous share-link viewers are not counted.
 * Returns: { ok: true, recorded: number }
 */
import type { ActionFunctionArgs } from "react-router";
import { getSessionUser } from "~/lib/auth.server";
import { normalizeEvents } from "./stats-events";
import { recordStats } from "./stats.server";

// check_*  a run started, by mode      suggested  underlines produced by a run
// clean    a run found nothing         accepted / dismissed  what the user did
// error    a run failed
const PR_EVENTS = ["check_fix", "check_improve", "suggested", "clean", "accepted", "dismissed", "error"] as const;

export async function action({ request }: ActionFunctionArgs) {
  const user = getSessionUser(request);
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { events?: unknown } | null;
  const rows = normalizeEvents(body?.events, PR_EVENTS);
  recordStats(rows);
  return Response.json({ ok: true, recorded: rows.length });
}
