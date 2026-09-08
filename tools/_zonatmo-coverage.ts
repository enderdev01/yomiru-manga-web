import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { getPgDb } from '../packages/db/src/index.js';
import { closePgDb } from '../packages/db/src/client.pg.js';

async function main() {
  const db = getPgDb();
  const matched = JSON.parse(await readFile('tools/data/capibara-matched.json', 'utf8')) as any[];
  const ids = new Set(matched.map((m) => m.seriesId));

  const r = await db.execute<any>(sql`
    SELECT s.id, s.title, s.source_name,
      COUNT(p.id)::int AS paginas,
      COUNT(*) FILTER (WHERE p.storage_path IS NOT NULL)::int AS r2
    FROM manga.series s
    JOIN manga.chapters c ON c.series_id = s.id
    JOIN manga.pages p ON p.chapter_id = c.id
    WHERE s.source_name ILIKE '%zonatmo%'
    GROUP BY s.id, s.title, s.source_name
  `);
  const rows: any[] = (r as any).rows ?? r;

  let mS = 0, mP = 0, uS = 0, uP = 0;
  const top: any[] = [];
  for (const x of rows) {
    if (ids.has(x.id)) { mS++; mP += x.paginas; }
    else { uS++; uP += x.paginas; top.push(x); }
  }
  console.log(`zonatmo con paginas: ${rows.length} series / ${mP + uP} paginas`);
  console.log(`  YA matcheadas en Capibara : ${mS} series / ${mP} paginas`);
  console.log(`  SIN match                 : ${uS} series / ${uP} paginas`);
  top.sort((a, b) => b.paginas - a.paginas);
  console.log('--- top 12 sin match (por peso) ---');
  for (const x of top.slice(0, 12)) console.log(`  ${String(x.title).slice(0,44).padEnd(46)} ${String(x.paginas).padStart(6)} pags`);
  await closePgDb();
}
main();
