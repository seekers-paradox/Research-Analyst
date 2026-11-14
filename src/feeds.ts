import type { Item, Source, SourceStatus } from "./types";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Feed text (possibly CDATA, possibly escaped HTML) to plain text. */
export function toText(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = decodeEntities(s);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return "";
}

function link(block: string): string {
  // Atom: <link href="..." rel="alternate"/>; prefer alternate, else first href.
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const href = (attrs: string) => attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  const alt = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a) && href(a));
  const any = alt ?? links.find((a) => !/rel\s*=/i.test(a) && href(a)) ?? links.find((a) => href(a));
  if (any) return decodeEntities(href(any)!);
  return toText(tag(block, ["link", "guid"]));
}

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function parseFeed(xml: string, source: Source): Promise<Item[]> {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const items: Item[] = [];
  for (const b of blocks) {
    const title = toText(tag(b, ["title"]));
    const url = link(b);
    const published = Date.parse(toText(tag(b, ["pubDate", "published", "updated", "dc:date"])));
    if (!title || !/^https?:\/\//i.test(url) || Number.isNaN(published)) continue;
    const snippet = toText(tag(b, ["description", "summary", "content:encoded", "content"])).slice(0, 400);
    items.push({
      id: await hash(url),
      title: title.slice(0, 300),
      url,
      source: source.name,
      category: source.category,
      weight: source.weight,
      published,
      snippet: snippet === title ? "" : snippet,
    });
  }
  return items;
}

export async function fetchSource(source: Source): Promise<{ items: Item[]; status: SourceStatus }> {
  try {
    const res = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ai-news-digest)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await parseFeed(await res.text(), source);
    if (items.length === 0) throw new Error("no items found in feed");
    return { items, status: { name: source.name, ok: true, items: items.length } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { items: [], status: { name: source.name, ok: false, items: 0, error } };
  }
}
