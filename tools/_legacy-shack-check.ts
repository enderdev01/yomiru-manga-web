import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { getPgDb } from '../packages/db/src/index.js';
import { closePgDb } from '../packages/db/src/client.pg.js';

async function main() {
  const r = await getPgDb().execute<any>(sql`
    SELECT s.id, s.title,
      COUNT(*) FILTER (WHERE p.source_url ILIKE '%imageshack%') AS shack,
      COUNT(*) FILTER (WHERE p.storage_path IS NOT NULL) AS r2
    FROM manga.series s
    JOIN manga.chapters c ON c.series_id = s.id
    JOIN manga.pages p ON p.chapter_id = c.id
    GROUP BY s.id, s.title
    HAVING COUNT(*) FILTER (WHERE p.source_url ILIKE '%imageshack%') > 0
    ORDER BY 3 DESC
  `);
  const rows: any[] = (r as any).rows ?? r;
  const matched = JSON.parse(await readFile('tools/data/capibara-matched.json', 'utf8')) as any[];
  const byId = new Map(matched.map((m) => [m.seriesId, m]));
  let hit = 0;
  for (const row of rows) {
    const m = byId.get(row.id);
    if (m) hit += 1;
    console.log(`${m ? 'OK ' : '-- '} ${String(row.title).slice(0, 40).padEnd(42)} shack=${String(row.shack).padStart(5)} ${m ? m.externalId : ''}`);
  }
  console.log(`\nseries con ImageShack: ${rows.length} | matcheadas en Capibara: ${hit}`);
  await closePgDb();
}
main();
