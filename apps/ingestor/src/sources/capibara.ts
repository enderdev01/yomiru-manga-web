import type {
  SourceProvider,
  DiscoveredSeries,
  DiscoveredChapter,
} from './types.js';

const BASE = 'https://capibaratraductor.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PACE_MS = 200;

interface ScanItem {
  id: string;
  name: string;
  slug?: string;
  url: string;
  isNSFW: boolean;
  totalMangas: number;
}

interface ScanListResponse {
  status: boolean;
  data: { items: ScanItem[]; total: number; maxPage: number; page: number };
}

interface ListingChapter {
  id: number;
  number: number;
  title: string | null;
  releasedAt: string | null;
}

interface MangaCustomBase {
  id: number;
  mangaId: number;
  title: string;
  shortDescription: string | null;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  status: string;
  isNSFW: boolean;
  views: number;
  releasedAt: string | null;
  workType: string;
  manga: {
    id: number;
    slug: string;
    title: string;
    description: string | null;
  };
  organization: { id: number; slug: string; name: string; isNSFW: boolean };
  chapters?: ChapterDetail[];
  genres?: Array<{ name: string } | string>;
}

interface ChapterDetail {
  id: number;
  number: number;
  title: string | null;
  releasedAt: string | null;
  isUnreleased: boolean;
  deletedAt: string | null;
}

interface ListingResponse {
  status: boolean;
  data: { items: MangaCustomBase[]; total: number; maxPage: number; page: number };
}

interface DetailResponse {
  status: boolean;
  data: MangaCustomBase;
}

interface PagesResponse {
  status: boolean;
  data: Array<{ number: number; imageUrl: string }>;
}

async function getJson<T>(path: string, init?: { organization?: string }): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json',
  };
  if (init?.organization) headers['x-organization'] = init.organization;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`capibara ${res.status} ${path}`);
  const json = (await res.json()) as { status: boolean; error?: string; message?: string };
  if (json.status === false) {
    throw new Error(`capibara api error ${path}: ${json.message || json.error}`);
  }
  return json as T;
}

function mapStatus(raw: string): DiscoveredSeries['status'] {
  const s = (raw || '').toLowerCase();
  if (s.includes('ongoing') || s.includes('curso') || s.includes('public')) return 'ongoing';
  if (s.includes('completed') || s.includes('final')) return 'completed';
  if (s.includes('hiatus') || s.includes('paus')) return 'hiatus';
  if (s.includes('cancel')) return 'cancelled';
  return 'unknown';
}

function buildSeriesUrl(scanSlug: string, mangaSlug: string): string {
  return `${BASE}/${scanSlug}/manga/${mangaSlug}`;
}

function buildChapterUrl(scanSlug: string, mangaSlug: string, number: number): string {
  return `${BASE}/${scanSlug}/manga/${mangaSlug}/chapters/${number}`;
}

/** externalId format: "{scanSlug}/{mangaSlug}" — composite to capture multitenant routing. */
function buildExternalId(scanSlug: string, mangaSlug: string): string {
  return `${scanSlug}/${mangaSlug}`;
}

function parseExternalId(externalId: string): { scanSlug: string; mangaSlug: string } {
  const idx = externalId.indexOf('/');
  if (idx <= 0) throw new Error(`bad capibara externalId: ${externalId}`);
  return {
    scanSlug: externalId.slice(0, idx),
    mangaSlug: externalId.slice(idx + 1),
  };
}

function mapToDiscoveredSeries(m: MangaCustomBase): DiscoveredSeries {
  const scanSlug = m.organization.slug;
  const mangaSlug = m.manga.slug;
  const totalChapters = (m.chapters ?? []).filter(
    (c) => !c.deletedAt && !c.isUnreleased,
  ).length;
  const popularity = m.views > 0 ? m.views : totalChapters;
  const year = m.releasedAt ? new Date(m.releasedAt).getUTCFullYear() : null;
  const genres = (m.genres ?? [])
    .map((g) => (typeof g === 'string' ? g : g.name))
    .filter(Boolean);

  return {
    externalId: buildExternalId(scanSlug, mangaSlug),
    slug: mangaSlug,
    title: m.title,
    altTitles: m.manga.title && m.manga.title !== m.title ? [m.manga.title] : [],
    description: m.description ?? m.shortDescription ?? null,
    coverUrl: m.imageUrl,
    rating: null,
    voteCount: 0,
    popularity,
    totalChapters,
    status: mapStatus(m.status),
    year: Number.isFinite(year) ? (year as number) : null,
    author: null,
    artist: null,
    genres,
    kind: m.workType === 'book' ? 'book' : 'manga',
    sourceUrl: buildSeriesUrl(scanSlug, mangaSlug),
  };
}

export class CapibaraProvider implements SourceProvider {
  readonly name = 'capibara';

  async *crawlCatalog(opts: {
    startPage?: number;
    maxPages?: number;
  } = {}): AsyncIterable<DiscoveredSeries> {
    const startPage = opts.startPage ?? 1;
    const maxPages = opts.maxPages ?? Infinity;
    let scanned = 0;

    for await (const scan of this.iterateScans()) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const body = await getJson<ListingResponse>(
          `/api/manga-custom?order=latest&limit=100&page=${page}`,
          { organization: scan.id },
        );
        totalPages = body.data.maxPage || 1;
        for (const item of body.data.items) {
          if (scanned < (startPage - 1) * 100) {
            scanned += 1;
            continue;
          }
          if (scanned >= startPage * 100 + (maxPages - 1) * 100) return;
          scanned += 1;
          yield mapToDiscoveredSeries(item);
        }
        page += 1;
        await sleep(PACE_MS);
      }
    }
  }

  private async *iterateScans(): AsyncIterable<ScanItem> {
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const body = await getJson<ScanListResponse>(`/api/landing/scans?page=${page}`);
      totalPages = body.data.maxPage || 1;
      for (const item of body.data.items) yield item;
      page += 1;
      await sleep(PACE_MS);
    }
  }

  async fetchSeriesDetails(externalId: string): Promise<{
    series: DiscoveredSeries;
    chapters: DiscoveredChapter[];
  }> {
    const { scanSlug, mangaSlug } = parseExternalId(externalId);
    const body = await getJson<DetailResponse>(`/api/manga-custom/${mangaSlug}`, {
      organization: scanSlug,
    });
    const m = body.data;
    const series = mapToDiscoveredSeries(m);

    const chapters: DiscoveredChapter[] = (m.chapters ?? [])
      .filter((c) => !c.deletedAt && !c.isUnreleased && Number.isFinite(c.number))
      .map((c) => ({
        externalId: String(c.id),
        number: c.number,
        title: c.title,
        language: 'es',
        publishedAt:
          c.releasedAt && !Number.isNaN(Date.parse(c.releasedAt))
            ? new Date(c.releasedAt)
            : null,
        sourceUrl: buildChapterUrl(scanSlug, mangaSlug, c.number),
      }));

    return { series, chapters };
  }

  async fetchChapterImages(chapter: {
    externalId: string;
    sourceUrl: string;
    seriesExternalId: string;
  }): Promise<string[]> {
    const { scanSlug, mangaSlug } = parseExternalId(chapter.seriesExternalId);
    const number = numberFromChapterUrl(chapter.sourceUrl);
    if (number === null) {
      throw new Error(`cannot derive chapter number from ${chapter.sourceUrl}`);
    }
    const body = await getJson<PagesResponse>(
      `/api/manga-custom/${mangaSlug}/chapter/${number}/pages`,
      { organization: scanSlug },
    );
    return body.data
      .sort((a, b) => a.number - b.number)
      .map((p) => p.imageUrl)
      .filter(Boolean);
  }
}

function numberFromChapterUrl(url: string): number | null {
  const m = url.match(/\/chapters\/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
