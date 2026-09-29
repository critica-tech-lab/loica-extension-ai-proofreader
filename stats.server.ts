/**
 * Outcome counters storage (see `stats-events.ts`). One row per day, language
 * and event, holding a running count. Read it with plain SQL, for example the
 * share of suggestions that were applied, by language:
 *
 *   SELECT lang,
 *          SUM(CASE WHEN event = 'accepted'  THEN count END) * 1.0 /
 *          SUM(CASE WHEN event = 'suggested' THEN count END) AS acceptance
 *   FROM pr_stats GROUP BY lang;
 */
import { db } from "~/lib/db.server";
import type { StatRow } from "./stats-events";

db.exec(`
  CREATE TABLE IF NOT EXISTS pr_stats (
    day   TEXT NOT NULL,
    lang  TEXT NOT NULL,
    event TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, lang, event)
  )
`);

const addCount = db.prepare(`
  INSERT INTO pr_stats (day, lang, event, count) VALUES (?, ?, ?, ?)
  ON CONFLICT (day, lang, event) DO UPDATE SET count = count + excluded.count
`);

export function recordStats(rows: StatRow[], now: Date = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  db.transaction(() => {
    for (const row of rows) {
      addCount.run(day, row.lang, row.event, row.count);
    }
  })();
}
