import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { CapibaraProvider } from '../apps/ingestor/src/sources/capibara.js';
import { replacePages, setChapterStatus, createId } from '../apps/ingestor/src/repo.js';
import { closePgDb, getPgDb, pgSchema } from '../packages/db/src/index.js';

const OUT_DIR = join(process.cwd(), 'tools', 'data');
const CONCURRENCY = 4;
const PACE_MS = 150;
const BACKUP_TABLE = 'pages_backup_replace';

interface MatchedEntry { seriesId: string; title: string; externalId: string }
interface LegacyChapter { id: string; number: number; language: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsOf = <T>(r: unknown): T[] =>
  ((r as { rows?: T[] }).rows ?? (r as T[])) ?? [];

function readArg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function ensureBackupTable(): Promise<void> {
  await getPgDb().execute(sql`
    CREATE TABLE IF NOT EXISTS manga.pages_backup_replace (
      id text, chapter_id text, idx integer, source_url text,
      storage_path text, width integer, height integer, bytes integer, mime text,
      backed_up_at timestamptz DEFAULT now()
    )
  `);
}

/** Snapshot every page of the chapter before it is deleted. */
async function backupChapterPages(chapterId: string): Promise<void> {
  await getPgDb().execute(sql`
    INSERT INTO manga.pages_backup_replace
      (id, chapter_id, idx, source_url, storage_path, width, height, bytes, mime)
    SELECT p.id, p.chapter_id, p.idx, p.source_url, p.storage_path,
           p.width, p.height, p.bytes, p.mime
    FROM manga.pages p
    WHERE p.chapter_id = ${chapterId}
  `);
}

async function getTargetSeries(entries: MatchedEntry[]): Promise<MatchedEntry[]> {
  const r = await getPgDb().execute<{ series_id: string }>(sql`
    SELECT DISTINCT c.series_id
    FROM manga.chapters c
    JOIN manga.pages p ON p.chapter_id = c.id
    WHERE p.storage_path IS NOT NULL
  `);
  const ids = new Set(rowsOf<{ series_id: string }>(r).map((x) => x.series_id));
  return entries.filter((e) => ids.has(e.seriesId));
}

async function getLegacyChapters(seriesId: string): Promise<LegacyChapter[]> {
  const r = await getPgDb().execute<LegacyChapter>(sql`
    SELECT DISTINCT c.id, c.number, c.language
    FROM manga.chapters c
    JOIN manga.pages p ON p.chapter_id = c.id
    WHERE c.series_id = ${seriesId} AND p.storage_path IS NOT NULL
    ORDER BY c.number
  `);
  return rowsOf<LegacyChapter>(r);
}

async function processSeries(
  provider: CapibaraProvider,
  entry: MatchedEntry,
  apply: boolean,
): Promise<{ replaced: number; absent: number; pages: number; failed: number }> {
  const [legacy, details] = await Promise.all([
    getLegacyChapters(entry.seriesId),
    provider.fetchSeriesDetails(entry.externalId),
  ]);
  const byNumber = new Map(details.chapters.map((c) => [Number(c.number), c]));
  const targets = legacy.flatMap((ch) => {
    const remote = byNumber.get(Number(ch.number));
    return remote ? [{ ch, remote }] : [];
  });
  const absent = legacy.length - targets.length;

  if (!apply) return { replaced: targets.length, absent, pages: 0, failed: 0 };

  let replaced = 0, pages = 0, failed = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async ({ ch, remote }) => {
      const urls = await provider.fetchChapterImages({
        externalId: remote.externalId,
        sourceUrl: remote.sourceUrl,
        seriesExternalId: entry.externalId,
      });
      if (urls.length === 0) throw new Error('capibara returned no images');

      await backupChapterPages(ch.id);
      await replacePages(ch.id, urls.map((sourceUrl, idx) => ({
        id: createId(),
        chapterId: ch.id,
        idx,
        sourceUrl,
        storagePath: null,
      })));
      await setChapterStatus(ch.id, 'completed', { pageCount: urls.length });
      return urls.length;
    }));

    for (const res of results) {
      if (res.status === 'fulfilled') { replaced += 1; pages += res.value; }
      else { failed += 1; console.warn(`[replace] ${entry.title}: ${String(res.reason)}`); }
    }
    await sleep(PACE_MS);
  }

  if (replaced > 0) {
    await getPgDb().update(pgSchema.series)
      .set({ coverPath: null, coverSourceUrl: details.series.coverUrl, updatedAt: new Date() })
      .where(eq(pgSchema.series.id, entry.seriesId));
  }
  return { replaced, absent, pages, failed };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const only = readArg('--only')?.toLowerCase();
  const limit = Number.parseInt(readArg('--limit') ?? '', 10);

  let entries = await getTargetSeries(JSON.parse(
    await readFile(join(OUT_DIR, 'capibara-matched.json'), 'utf8'),
  ) as MatchedEntry[]);
  if (only) entries = entries.filter((e) =>
    e.title.toLowerCase().includes(only) || e.externalId.toLowerCase().includes(only));
  if (Number.isFinite(limit)) entries = entries.slice(0, limit);

  if (apply) await ensureBackupTable();
  console.log(`[replace] mode=${apply ? 'APPLY' : 'dry-run'} series=${entries.length}`);

  const provider = new CapibaraProvider();
  let replaced = 0, absent = 0, pages = 0, failed = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    try {
      const r = await processSeries(provider, e, apply);
      replaced += r.replaced; absent += r.absent; pages += r.pages; failed += r.failed;
      console.log(`[replace] ${i + 1}/${entries.length} ${e.title}: replaced=${r.replaced} absent=${r.absent} failed=${r.failed} pages=${r.pages}`);
    } catch (err) {
      console.warn(`[replace] ${e.title} failed: ${(err as Error).message}`);
    }
    await sleep(PACE_MS);
  }

  console.log(`[replace] complete replaced=${replaced} absent=${absent} failed=${failed} pages=${pages}`);
  if (!apply) console.log('[replace] no data changed; rerun with --apply to persist');
}

main().then(
  async () => { await closePgDb(); process.exit(0); },
  async (e) => { console.error('[replace] fatal:', e); try { await closePgDb(); } catch {} process.exit(1); },
);
