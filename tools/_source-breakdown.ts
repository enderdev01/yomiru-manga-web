import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getPgDb } from '../packages/db/src/index.js';
import { closePgDb } from '../packages/db/src/client.pg.js';

async function main() {
  const db = getPgDb();
  const p = await db.execute<any>(sql`
    SELECT
      CASE
        WHEN source_url ILIKE '%capibara%' THEN 'capibara'
        WHEN source_url ILIKE '%imageshack%' THEN 'imageshack'
        WHEN source_url ILIKE '%zonatmo%' OR source_url ILIKE '%tmofans%' THEN 'zonatmo'
        ELSE 'otro'
      END AS origen,
      COUNT(*)::int AS paginas,
      COUNT(*) FILTER (WHERE storage_path IS NOT NULL)::int AS con_r2
    FROM manga.pages GROUP BY 1 ORDER BY 2 DESC
  `);
  console.log('--- PAGINAS por origen ---');
  for (const x of ((p as any).rows ?? p)) console.log(`  ${x.origen.padEnd(11)} ${String(x.paginas).padStart(8)}  (r2=${x.con_r2})`);

  const s = await db.execute<any>(sql`
    SELECT source_name, COUNT(*)::int AS series FROM manga.series GROUP BY 1 ORDER BY 2 DESC LIMIT 8
  `);
  console.log('--- SERIES por source_name ---');
  for (const x of ((s as any).rows ?? s)) console.log(`  ${String(x.source_name).padEnd(11)} ${String(x.series).padStart(6)}`);

  const c = await db.execute<any>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE cover_path IS NOT NULL)::int AS cover_r2,
      COUNT(*) FILTER (WHERE cover_source_url ILIKE '%capibara%')::int AS cover_capi,
      COUNT(*) FILTER (WHERE banner_source_url ILIKE '%anilist%' OR banner_source_url ILIKE '%anili.st%')::int AS banner_anilist,
      COUNT(*) FILTER (WHERE banner_source_url ILIKE '%capibara%')::int AS banner_capi
    FROM manga.series
  `);
  console.log('--- PORTADAS / BANNERS ---');
  console.log('  ' + JSON.stringify(((c as any).rows ?? c)[0]));
  await closePgDb();
}
main();
