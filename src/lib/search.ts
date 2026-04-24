import * as cheerio from "cheerio";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  excerpt?: string;
};

// Realistic browser User-Agent to avoid being blocked by DuckDuckGo
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

export async function collectSearchContext(
  query: string,
  mode: "web" | "deep",
): Promise<SearchResult[]> {
  const queries =
    mode === "web"
      ? [query]
      : buildResearchQueries(query).slice(0, 5);

  const settled = await Promise.allSettled(
    queries.map((item) => searchDuckDuckGo(item, mode === "web" ? 5 : 4)),
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

  if (mode === "deep") {
    const enriched = await Promise.allSettled(
      topResults.slice(0, 5).map(async (item) => ({
        ...item,
        excerpt: await fetchReadableExcerpt(item.url),
      })),
    );

    for (let index = 0; index < enriched.length; index += 1) {
      const item = enriched[index];
      if (item.status === "fulfilled") {
        topResults[index] = item.value;
      }
    }
  }

  return topResults;
}

export function formatSearchContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No web results were available.";
  }

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

function buildResearchQueries(query: string): string[] {
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  const currentYear = new Date().getFullYear();

  return [
    cleanQuery,
    `${cleanQuery} ${currentYear}`,
    `${cleanQuery} analysis`,
    `${cleanQuery} official sources`,
    `${cleanQuery} report`,
  ];
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  // Try standard HTML endpoint first, fall back to lite version
  try {
    const results = await searchDuckDuckGoHtml(query, limit, "https://html.duckduckgo.com/html/");
    if (results.length > 0) return results;
    // If we got 0 results from main endpoint, try lite as fallback
    const liteResults = await searchDuckDuckGoHtml(query, limit, "https://lite.duckduckgo.com/lite/");
    return liteResults;
  } catch {
    // Try lite endpoint as final fallback
    try {
      return await searchDuckDuckGoHtml(query, limit, "https://lite.duckduckgo.com/lite/");
    } catch {
      return [];
    }
  }
}

async function searchDuckDuckGoHtml(
  query: string,
  limit: number,
  baseEndpoint: string,
): Promise<SearchResult[]> {
  const url = new URL(baseEndpoint);
  url.searchParams.set("q", query);
  // Request in English to ensure consistent HTML structure
  url.searchParams.set("kl", "us-en");

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Search returned ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // DuckDuckGo HTML uses .result / .result__a / .result__snippet
  // Lite version uses a table structure with .result-link / .result-snippet
  const isLite = baseEndpoint.includes("lite");

  if (isLite) {
    $("tr").each((_, row) => {
      if (results.length >= limit) return false;
      const anchor = $(row).find("a.result-link");
      if (!anchor.length) return undefined;
      const title = cleanText(anchor.text());
      const href = anchor.attr("href");
      const resolvedUrl = href ? resolveRedirect(href) : undefined;
      const snippet = cleanText($(row).next("tr").find(".result-snippet").text());
      if (!title || !resolvedUrl) return undefined;
      results.push({ title, url: resolvedUrl, snippet, displayUrl: makeDisplayUrl(resolvedUrl) });
      return undefined;
    });
  } else {
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
  }

  return results;
}

function resolveRedirect(href: string): string | undefined {
  try {
    const url = new URL(href, "https://lite.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (href.startsWith("http")) return href;
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchReadableExcerpt(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        ...BROWSER_HEADERS,
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(6500),
    });

    if (!response.ok) return undefined;

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      return undefined;
    }

    const text = await response.text();
    const $ = cheerio.load(text);
    $("script, style, nav, footer, header, aside, noscript").remove();
    const paragraphs = $("main p, article p, p")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .filter((item) => item.length > 80);

    return truncateText(paragraphs.slice(0, 8).join("\n"), 2200);
  } catch {
    return undefined;
  }
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
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}
