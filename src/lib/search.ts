import * as cheerio from "cheerio";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  excerpt?: string;
};

// ── SearXNG — primary (open meta-search, JSON API, works from cloud IPs) ─────

type SearXNGResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

// Multiple public instances as fallback chain
const SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://searxng.world",
  "https://search.sapti.me",
  "https://priv.au",
];

async function searchSearXNG(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  for (const instance of SEARXNG_INSTANCES) {
    try {
      const url = new URL(`${instance}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", "auto");
      url.searchParams.set("safesearch", "0");

      const response = await fetch(url.toString(), {
        cache: "no-store",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; Deepbox/1.0; +https://deepbox.chat)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as SearXNGResponse;
      if (!data.results?.length) continue;

      const results = data.results
        .slice(0, limit)
        .map((item) => ({
          title: item.title ?? "",
          url: item.url ?? "",
          snippet: item.content ?? "",
          displayUrl: makeDisplayUrl(item.url ?? ""),
        }))
        .filter((r) => r.title && r.url);

      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

// ── Jina AI Search — secondary (no key, JSON API) ─────────────────────────────

type JinaSearchResponse = {
  data?: Array<{
    title?: string;
    url?: string;
    description?: string;
    content?: string;
  }>;
};

async function searchJina(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = `https://s.jina.ai/?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "X-Return-Format": "json",
      "X-No-Cache": "true",
    },
    signal: AbortSignal.timeout(14000),
  });

  if (!response.ok) throw new Error(`Jina returned ${response.status}`);

  const data = (await response.json()) as JinaSearchResponse;
  if (!data.data?.length) return [];

  return data.data
    .slice(0, limit)
    .map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.description ?? "",
      displayUrl: makeDisplayUrl(item.url ?? ""),
      excerpt: item.content ? truncateText(item.content, 2000) : undefined,
    }))
    .filter((r) => r.title && r.url);
}

// ── DuckDuckGo HTML — tertiary (often blocked from datacenter IPs) ────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function searchDuckDuckGo(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", "us-en");

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(9000),
  });

  if (!response.ok) throw new Error(`DDG returned ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result:not(.result--ad)").each((_, element) => {
    if (results.length >= limit) return false;
    const root = $(element);
    const anchor = root.find(".result__a").first();
    const rawHref = anchor.attr("href");
    const title = cleanText(anchor.text());
    const resolvedUrl = unwrapDuckDuckGoUrl(rawHref);
    const snippet = cleanText(root.find(".result__snippet").text());
    if (!title || !resolvedUrl) return undefined;
    results.push({ title, url: resolvedUrl, snippet, displayUrl: makeDisplayUrl(resolvedUrl) });
    return undefined;
  });

  return results;
}

// ── Provider waterfall ────────────────────────────────────────────────────────

async function searchWithFallback(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  // 1. SearXNG (most reliable from cloud)
  try {
    const results = await searchSearXNG(query, limit);
    if (results.length > 0) return results;
  } catch {
    // fall through
  }

  // 2. Jina AI
  try {
    const results = await searchJina(query, limit);
    if (results.length > 0) return results;
  } catch {
    // fall through
  }

  // 3. DuckDuckGo (often blocked but worth trying)
  try {
    return await searchDuckDuckGo(query, limit);
  } catch {
    return [];
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function collectSearchContext(
  query: string,
  mode: "web" | "deep",
): Promise<SearchResult[]> {
  const queries =
    mode === "web" ? [query] : buildResearchQueries(query).slice(0, 4);

  const settled = await Promise.allSettled(
    queries.map((q) => searchWithFallback(q, mode === "web" ? 6 : 4)),
  );

  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const key = normalizeForDedupe(item.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  const topResults = merged.slice(0, mode === "web" ? 6 : 10);

  // Enrich top results with Jina reader excerpts in deep mode
  if (mode === "deep") {
    const enriched = await Promise.allSettled(
      topResults.slice(0, 5).map(async (item) => {
        if (!item.excerpt) {
          item.excerpt = await fetchJinaReader(item.url);
        }
        return item;
      }),
    );
    for (let i = 0; i < enriched.length; i++) {
      const r = enriched[i];
      if (r.status === "fulfilled") topResults[i] = r.value;
    }
  }

  return topResults;
}

export function formatSearchContext(results: SearchResult[]): string {
  if (results.length === 0) return "";

  return results
    .map((result, index) => {
      const lines = [
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
        `Snippet: ${result.snippet || "—"}`,
      ];
      if (result.excerpt) lines.push(`Excerpt: ${result.excerpt}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── Jina Reader (deep mode excerpts) ─────────────────────────────────────────

async function fetchJinaReader(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      cache: "no-store",
      headers: { Accept: "text/plain", "X-Return-Format": "text" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return truncateText(text.trim(), 2000);
  } catch {
    return undefined;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildResearchQueries(query: string): string[] {
  const clean = query.replace(/\s+/g, " ").trim();
  const year = new Date().getFullYear();
  return [clean, `${clean} ${year}`, `${clean} analysis`, `${clean} latest`];
}

function unwrapDuckDuckGoUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return undefined;
  }
}

function normalizeForDedupe(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign"].forEach((p) =>
      parsed.searchParams.delete(p),
    );
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function makeDisplayUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}
