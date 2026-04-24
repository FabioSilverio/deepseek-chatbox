import * as cheerio from "cheerio";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  excerpt?: string;
};

// ── Jina AI Search (primary — no API key, works from cloud IPs) ──────────────

type JinaSearchResponse = {
  code?: number;
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
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "X-Return-Format": "json",
      "X-With-Links-Summary": "false",
    },
    signal: AbortSignal.timeout(14000),
  });

  if (!response.ok) {
    throw new Error(`Jina search returned ${response.status}`);
  }

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

// ── DuckDuckGo HTML (fallback — may be blocked from data-center IPs) ────────

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
    results.push({
      title,
      url: resolvedUrl,
      snippet,
      displayUrl: makeDisplayUrl(resolvedUrl),
    });
    return undefined;
  });

  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function collectSearchContext(
  query: string,
  mode: "web" | "deep",
): Promise<SearchResult[]> {
  const queries =
    mode === "web"
      ? [query]
      : buildResearchQueries(query).slice(0, 4);

  // Run all queries; try Jina first, fall back to DuckDuckGo per query
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

  // For deep mode, enrich top results with full page text
  if (mode === "deep") {
    const enriched = await Promise.allSettled(
      topResults.slice(0, 5).map(async (item) => {
        // Jina reader can also fetch a clean page excerpt
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

async function searchWithFallback(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  try {
    const results = await searchJina(query, limit);
    if (results.length > 0) return results;
  } catch {
    // Jina failed — try DuckDuckGo
  }
  try {
    return await searchDuckDuckGo(query, limit);
  } catch {
    return [];
  }
}

export function formatSearchContext(results: SearchResult[]): string {
  if (results.length === 0) return "No web results were available.";

  return results
    .map((result, index) => {
      const lines = [
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
        `Snippet: ${result.snippet || "No snippet."}`,
      ];
      if (result.excerpt) {
        lines.push(`Excerpt: ${result.excerpt}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── Jina reader for deep mode excerpts ───────────────────────────────────────

async function fetchJinaReader(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      cache: "no-store",
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "text",
      },
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
  return [
    clean,
    `${clean} ${year}`,
    `${clean} analysis`,
    `${clean} latest news`,
  ];
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
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
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
