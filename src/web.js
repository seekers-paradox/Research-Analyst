// Fetching pages and running searches from the Worker. Workers on the Free
// plan get ~10ms of CPU per request, so extraction is plain regex over a
// capped amount of HTML rather than a full DOM parse.

const MAX_HTML = 400_000;
const MAX_TEXT = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ResearchAnalystBot/1.0; +https://workers.dev) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#8217": "’", "#8211": "–", "#8212": "—" };

function decode(text) {
  return text.replace(/&(#?[a-z0-9]+);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16) || 32);
    if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)) || 32);
    return m;
  });
}

function stripTags(html) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function parseUrl(raw) {
  let value = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) throw new Error("Invalid URL");
  return url;
}

// Fetches a page and returns its title, description, readable text, and
// same-site links (used to find About/Services/Contact pages).
export async function fetchPage(rawUrl) {
  const url = parseUrl(rawUrl);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    cf: { cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`The site returned HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!/html|text\/plain/i.test(type)) throw new Error(`Not a web page (${type || "unknown type"})`);

  const html = (await res.text()).slice(0, MAX_HTML);
  const finalUrl = new URL(res.url || url);

  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = decode(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      "",
  ).trim();

  const links = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 60) break;
    try {
      const link = new URL(decode(m[1]), finalUrl);
      if (link.hostname.replace(/^www\./, "") !== finalUrl.hostname.replace(/^www\./, "")) continue;
      link.hash = "";
      if (seen.has(link.href) || /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4)$/i.test(link.pathname)) continue;
      seen.add(link.href);
      links.push({ url: link.href, text: stripTags(m[2]).slice(0, 80) });
    } catch {
      // ignore malformed hrefs
    }
  }

  const socials = [...new Set(
    [...html.matchAll(/https?:\/\/(?:www\.)?(?:facebook|instagram|linkedin|tiktok|youtube|x|twitter|pinterest|yelp)\.com\/[^"'\s<>)]+/gi)].map((m) => m[0]).filter((u) => !/\/(sharer|share|plugins|dialog|intent|2008\/fbml)/i.test(u)),
  )].slice(0, 12);

  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/header|\/footer)\b[^>]*>/gi, "\n");
  // Strip tags again after decoding: some builders embed entity-encoded markup.
  const text = decode(body.replace(/<[^>]+>/g, " "))
    .replace(/<\/?[a-z][^>]*>?/gi, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT);

  return { url: finalUrl.href, title, description, text, links, socials };
}

async function braveSearch(query, apiKey) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? "") }));
}

export async function search(query, env) {
  const q = String(query ?? "").trim().slice(0, 300);
  if (!q) throw new Error("Empty search query");
  // Free search-engine pages block or degrade automated requests from
  // Cloudflare, so web search needs a Brave Search API key.
  if (!env.BRAVE_API_KEY) throw new Error("Web search is not configured (set the BRAVE_API_KEY secret).");
  return { provider: "brave", results: await braveSearch(q, env.BRAVE_API_KEY) };
}
