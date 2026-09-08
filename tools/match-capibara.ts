import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import slugify from 'slugify';
import { sql } from 'drizzle-orm';
import { getPgDb, pgSchema } from '../packages/db/src/index.js';

const BASE = 'https://capibaratraductor.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PACE_MS = 150;
const OUT_DIR = join(process.cwd(), 'tools', 'data');

interface ScanItem {
  id: string;
  name: string;
  totalMangas: number;
}

interface CapibaraEntry {
  scanSlug: string;
  scanName: string;
  mangaSlug: string;
  mangaCustomId: number;
  title: string;
  altTitle: string | null;
  isNSFW: boolean;
  views: number;
  totalChapters: number;
  imageUrl: string | null;
  bannerUrl: string | null;
  status: string;
  description: string | null;
}

function norm(s: string | null | undefined): string {
  if (!s) return '';
  return slugify(s, { lower: true, strict: true, locale: 'es' });
}

async function getJson<T>(path: string, organization?: string): Promise<T> {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (organization) headers['x-organization'] = organization;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`capibara ${res.status} ${path}`);
  const j = (await res.json()) as { status: boolean; data?: unknown; error?: string; message?: string };
  if (j.status === false) throw new Error(`capibara ${path}: ${j.message || j.error}`);
  return j as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listAllScans(): Promise<ScanItem[]> {
  const out: ScanItem[] = [];
  let page = 1;
  let max = 1;
  while (page <= max) {
    const body = await getJson<{ data: { items: ScanItem[]; maxPage: number } }>(
      `/api/landing/scans?page=${page}`,
    );
    max = body.data.maxPage || 1;
    out.push(...body.data.items);
    page += 1;
    await sleep(PACE_MS);
  }
  return out;
}

async function listScanMangas(scanSlug: string): Promise<CapibaraEntry[]> {
  const out: CapibaraEntry[] = [];
  let page = 1;
  let max = 1;
  while (page <= max) {
    const body = await getJson<{
      data: {
        items: Array<{
          id: number;
          title: string;
          shortDescription: string | null;
          description: string | null;
          imageUrl: string | null;
          bannerUrl: string | null;
          status: string;
          isNSFW: boolean;
          views: number;
          manga: { slug: string; title: string };
          organization: { slug: string; name: string };
          chapters?: unknown[];
        }>;
        maxPage: number;
      };
    }>(
      `/api/manga-custom?order=latest&limit=100&page=${page}`,
      scanSlug,
    );
    max = body.data.maxPage || 1;
    for (const it of body.data.items) {
      out.push({
        scanSlug: it.organization.slug,
        scanName: it.organization.name,
        mangaSlug: it.manga.slug,
        mangaCustomId: it.id,
        title: it.title,
        altTitle: it.manga.title && it.manga.title !== it.title ? it.manga.title : null,
        isNSFW: !!it.isNSFW,
        views: it.views ?? 0,
        totalChapters: Array.isArray(it.chapters) ? it.chapters.length : 0,
        imageUrl: it.imageUrl,
        bannerUrl: it.bannerUrl,
        status: it.status,
        description: it.description ?? it.shortDescription ?? null,
      });
    }
    page += 1;
    await sleep(PACE_MS);
  }
  return out;
}

async function buildCapibaraIndex(): Promise<CapibaraEntry[]> {
  console.log('[matcher] discovering scans...');
  const scans = await listAllScans();
  console.log(`[matcher] ${scans.length} scans found`);

  const all: CapibaraEntry[] = [];
  for (const scan of scans) {
    try {
      const list = await listScanMangas(scan.id);
      console.log(`[matcher] ${scan.id} → ${list.length} mangas`);
      all.push(...list);
    } catch (e) {
      console.warn(`[matcher] scan ${scan.id} failed: ${(e as Error).message}`);
    }
  }
  return all;
}

async function loadSupabaseSeries() {
  const db = getPgDb();
  const { series } = pgSchema;
  const rows = await db
    .select({
      id: series.id,
      title: series.title,
      normalizedTitle: series.normalizedTitle,
      altTitles: series.altTitles,
      sourceName: series.sourceName,
      sourceUrl: series.sourceUrl,
      kind: series.kind,
    })
    .from(series);
  return rows;
}

interface MatchResult {
  seriesId: string;
  title: string;
  sourceName: string;
  externalId: string;
  scanSlug: string;
  mangaSlug: string;
  capibaraTitle: string;
  matchedOn: 'normalizedTitle' | 'altTitle';
  candidates: number;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Capibara catalog index (cached on disk to allow re-runs)
  const cachePath = join(OUT_DIR, 'capibara-catalog.json');
  let catalog: CapibaraEntry[] = [];
  if (process.argv.includes('--refresh') || !(await fileExists(cachePath))) {
    catalog = await buildCapibaraIndex();
    await writeFile(cachePath, JSON.stringify(catalog, null, 2));
    console.log(`[matcher] catalog cached → ${cachePath} (${catalog.length} entries)`);
  } else {
    catalog = JSON.parse(await (await import('node:fs/promises')).readFile(cachePath, 'utf8'));
    console.log(`[matcher] catalog loaded from cache (${catalog.length} entries) — pass --refresh to rebuild`);
  }

  // 2. Index by normalized title
  const byTitleNorm = new Map<string, CapibaraEntry[]>();
  for (const e of catalog) {
    const k = norm(e.title);
    if (!k) continue;
    (byTitleNorm.get(k) ?? byTitleNorm.set(k, []).get(k)!).push(e);
    if (e.altTitle) {
      const k2 = norm(e.altTitle);
      if (k2 && k2 !== k) (byTitleNorm.get(k2) ?? byTitleNorm.set(k2, []).get(k2)!).push(e);
    }
  }

  // 3. Pull Supabase series
  const series = await loadSupabaseSeries();
  console.log(`[matcher] supabase series: ${series.length}`);

  // 4. Match
  const matched: MatchResult[] = [];
  const pending: Array<{
    seriesId: string;
    title: string;
    altTitles: string[];
    sourceName: string;
    sourceUrl: string;
  }> = [];

  const matchedExternalIds = new Set<string>();

  for (const s of series) {
    const candidates = (byTitleNorm.get(s.normalizedTitle) ?? []).slice();
    let how: 'normalizedTitle' | 'altTitle' = 'normalizedTitle';
    if (candidates.length === 0) {
      for (const alt of s.altTitles ?? []) {
        const hit = byTitleNorm.get(norm(alt));
        if (hit) {
          candidates.push(...hit);
          how = 'altTitle';
        }
      }
    }
    if (candidates.length === 0) {
      pending.push({
        seriesId: s.id,
        title: s.title,
        altTitles: s.altTitles ?? [],
        sourceName: s.sourceName,
        sourceUrl: s.sourceUrl,
      });
      continue;
    }
    // Pick best: most chapters, then most views
    candidates.sort((a, b) => b.totalChapters - a.totalChapters || b.views - a.views);
    const best = candidates[0];
    const externalId = `${best.scanSlug}/${best.mangaSlug}`;
    matched.push({
      seriesId: s.id,
      title: s.title,
      sourceName: s.sourceName,
      externalId,
      scanSlug: best.scanSlug,
      mangaSlug: best.mangaSlug,
      capibaraTitle: best.title,
      matchedOn: how,
      candidates: candidates.length,
    });
    matchedExternalIds.add(externalId);
  }

  // 5. Capibara entries NOT already in our DB → ingest queue
  const extra = catalog.filter(
    (e) => !matchedExternalIds.has(`${e.scanSlug}/${e.mangaSlug}`),
  );

  await writeFile(join(OUT_DIR, 'capibara-matched.json'), JSON.stringify(matched, null, 2));
  await writeFile(join(OUT_DIR, 'capibara-pending.json'), JSON.stringify(pending, null, 2));
  await writeFile(join(OUT_DIR, 'capibara-extra.json'), JSON.stringify(extra, null, 2));

  console.log('---');
  console.log(`matched:  ${matched.length}`);
  console.log(`pending:  ${pending.length}  → tools/data/capibara-pending.json`);
  console.log(`extra:    ${extra.length}    → tools/data/capibara-extra.json (ingest as new)`);
  console.log(`catalog:  ${catalog.length}`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).stat(p);
    return true;
  } catch {
    return false;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAIL:', e);
    process.exit(1);
  },
);
