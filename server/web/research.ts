import { safeGet } from "./net";

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type WebSearchResult =
  | { readonly ok: true; readonly query: string; readonly results: readonly SearchHit[] }
  | { readonly ok: false; readonly error: string };

export type WebFetchResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly title: string | null;
      readonly contentType: string;
      readonly content: string;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 16_000;
const HARD_MAX_CHARS = 40_000;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return NAMED_ENTITIES[lower] ?? full;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeDdgUrl(rawHref: string): string {
  const href = decodeEntities(rawHref.trim());
  const normalized = href.startsWith("//") ? `https:${href}` : href;
  try {
    const parsed = new URL(normalized, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    if (/^https?:\/\//i.test(parsed.href)) return parsed.href;
  } catch {
    // Fall back to raw href
  }
  return href;
}

/** Parses search results from DuckDuckGo's HTML or Lite page. */
export function parseDdgHtml(html: string, limit = 6): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  // Standard html.duckduckgo.com markup: <a class="result__a" href="...">Title</a> ... <a class="result__snippet">...</a>
  const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<(?:a|div|span)[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi;

  const links: { url: string; title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const url = decodeDdgUrl(m[1] ?? "");
    const title = stripTags(m[2] ?? "");
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    links.push({ url, title, index: m.index });
  }

  const snippets: { text: string; index: number }[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push({ text: stripTags(m[1] ?? ""), index: m.index });
  }

  for (let i = 0; i < links.length && hits.length < limit; i++) {
    const cur = links[i]!;
    if (seen.has(cur.url)) continue;
    seen.add(cur.url);
    const nextIdx = links[i + 1]?.index ?? Infinity;
    const snip = snippets.find((s) => s.index > cur.index && s.index < nextIdx)?.text ?? "";
    hits.push({ title: cur.title, url: cur.url, snippet: snip });
  }

  // Fallback: lite.duckduckgo.com uses <a rel="nofollow" href="..." class='result-link'>
  if (hits.length === 0) {
    const liteRe = /<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRe.exec(html)) !== null && hits.length < limit) {
      const url = decodeDdgUrl(m[1] ?? "");
      const title = stripTags(m[2] ?? "");
      if (!url || !title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      hits.push({ title, url, snippet: "" });
    }
  }

  return hits;
}

/** Converts an HTML document to clean, readable Markdown/plain text. */
export function htmlToMarkdown(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1] ?? "") || null : null;

  // Prefer <main> or <article> when present and substantial.
  const mainMatch =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  let body = mainMatch && mainMatch[1] && mainMatch[1].length > 400 ? mainMatch[1] : html;

  // Drop non-content blocks.
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Convert structural elements to lightweight Markdown.
  body = body
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => `\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
      const clean = stripTags(inner);
      return clean ? `\n${"#".repeat(Number(lvl))} ${clean}\n` : "";
    })
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = stripTags(inner);
      if (!label) return "";
      if (/^https?:\/\//i.test(href)) return `[${label}](${decodeEntities(href)})`;
      return label;
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
      const clean = stripTags(inner);
      return clean ? `\n- ${clean}` : "";
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
      const clean = stripTags(inner);
      return clean ? `\`${clean}\`` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|blockquote|dl|dt|dd|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const text = decodeEntities(body)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

export async function runWebSearch(query: string, limit = 6): Promise<WebSearchResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return { ok: false, error: "Query is empty" };
  const clampedLimit = Math.max(1, Math.min(12, Math.round(limit)));

  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(cleanQuery)}`,
  ];

  let lastError = "No results found";
  for (const endpoint of endpoints) {
    const res = await safeGet(endpoint, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: 12_000,
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    if (!res.ok) {
      lastError = res.error;
      continue;
    }
    const html = res.body.toString("utf8");
    const results = parseDdgHtml(html, clampedLimit);
    if (results.length > 0) {
      return { ok: true, query: cleanQuery, results };
    }
  }

  return { ok: false, error: lastError };
}

export async function runWebFetch(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<WebFetchResult> {
  const cleanUrl = url.trim();
  if (!cleanUrl) return { ok: false, error: "URL is empty" };
  const cap = Math.max(500, Math.min(HARD_MAX_CHARS, Math.round(maxChars)));

  const res = await safeGet(cleanUrl, {
    accept: "text/markdown,text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
    maxBytes: MAX_PAGE_BYTES,
    timeoutMs: 15_000,
    headers: { "accept-language": "en-US,en;q=0.9" },
  });
  if (!res.ok) return { ok: false, error: res.error };

  const contentType = String(res.headers["content-type"] ?? "text/plain").split(";")[0]!.trim().toLowerCase();
  const raw = res.body.toString("utf8");

  let title: string | null = null;
  let text: string;
  if (contentType.includes("html")) {
    const converted = htmlToMarkdown(raw);
    title = converted.title;
    text = converted.text;
  } else {
    text = raw.trim();
  }

  const truncated = text.length > cap;
  const content = truncated ? `${text.slice(0, cap)}\n\n…[truncated at ${cap} chars]` : text;

  return {
    ok: true,
    url: res.url,
    title,
    contentType,
    content,
    truncated,
  };
}
