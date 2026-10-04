// Fetching pages and running Google Maps searches (via SerpApi) from the
// Worker. Workers on the Free plan get ~10ms of CPU per request, so page
// extraction is plain regex over a capped amount of HTML.

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

// ---------- SerpApi (Google Maps results) ----------
// https://serpapi.com/google-maps-api and https://serpapi.com/google-maps-reviews-api

async function serpApi(params, env) {
  if (!env.SERPAPI_KEY) throw new Error("Local search is not configured (set the SERPAPI_KEY secret).");
  const url = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries({ hl: "en", ...params })) url.searchParams.set(k, v);
  url.searchParams.set("api_key", env.SERPAPI_KEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // SerpApi reports "no results" as an error; treat it as an empty result.
    if (/hasn't returned any results/i.test(data.error ?? "")) return {};
    throw new Error(`SerpApi: ${data.error || `HTTP ${res.status}`}`);
  }
  return data;
}

function hoursList(p) {
  const hours = p.operating_hours ?? p.hours;
  if (Array.isArray(hours)) return hours.flatMap((h) => (typeof h === "object" ? Object.entries(h).map(([d, t]) => `${d}: ${t}`) : [String(h)]));
  if (hours && typeof hours === "object") return Object.entries(hours).map(([d, t]) => `${d}: ${t}`);
  return typeof hours === "string" ? [hours] : [];
}

// Google listings often append tracking parameters to the website link.
function cleanWebsite(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid|y_source)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return String(raw);
  }
}

function normalizePlace(p) {
  const closed = /permanently closed/i.test(`${p.open_state ?? ""} ${p.business_status ?? ""}`);
  return {
    name: p.title ?? "",
    address: p.address ?? "",
    type: p.type ?? (Array.isArray(p.types) ? p.types[0] : "") ?? "",
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: Number(p.reviews) || 0,
    website: cleanWebsite(p.website),
    phone: p.phone ?? "",
    status: closed ? "CLOSED_PERMANENTLY" : "",
    hours: hoursList(p).slice(0, 7),
    dataId: p.data_id ?? "",
    reviews: (p.user_reviews?.most_relevant ?? []).slice(0, 5).map((r) => ({
      rating: r.rating ?? null,
      when: r.date ?? "",
      text: String(r.description ?? r.snippet ?? "").slice(0, 600),
    })),
  };
}

// Google Maps search, e.g. "home builder in Kansas City" or "Century Homes Kansas City".
export async function mapsSearch(query, env, limit = 10) {
  const q = String(query ?? "").trim().slice(0, 300);
  if (!q) throw new Error("Empty search query");
  const data = await serpApi({ engine: "google_maps", type: "search", q }, env);
  // A query that matches one business returns place_results instead of a list.
  if (data.place_results) return [normalizePlace(data.place_results)];
  return (data.local_results ?? []).slice(0, limit).map(normalizePlace);
}

// Most relevant Google reviews for one place.
export async function mapsReviews(dataId, env) {
  const id = String(dataId ?? "").trim();
  if (!/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(id)) throw new Error("Invalid place id");
  const data = await serpApi({ engine: "google_maps_reviews", data_id: id }, env);
  return (data.reviews ?? []).slice(0, 8).map((r) => ({
    rating: r.rating ?? null,
    when: r.date ?? "",
    text: String(r.snippet ?? r.extracted_snippet?.original ?? "").slice(0, 600),
  }));
}
