import { fetchSource } from "./feeds";
import { SOURCES } from "./sources";
import { summarize } from "./summarize";
import { CATEGORY_ORDER, type Category, type Digest, type Env, type Item, type Source } from "./types";

const HOUR = 3_600_000;
/** Most candidates handed to Claude to choose from. */
const MAX_CANDIDATES = 80;

function normTitle(t: string): string {
  // Google News appends " - Publisher"; drop it so the same story dedupes.
  return t.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function score(item: Item, now: number): number {
  const ageHours = Math.max(0, (now - item.published) / HOUR);
  return item.weight * 10 - ageHours / 6;
}

/** Recent, deduplicated items, best first. */
export function selectCandidates(items: Item[], now: number, windowHours: number, jobsWindowHours: number): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  const sorted = [...items].sort((a, b) => score(b, now) - score(a, now));
  for (const it of sorted) {
    const window = it.category === "jobs" ? jobsWindowHours : windowHours;
    if (it.published > now + HOUR || now - it.published > window * HOUR) continue;
    const key = normTitle(it.title);
    if (!key || seen.has(key) || seen.has(it.url)) continue;
    seen.add(key);
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

export function toSections(items: Item[], maxPerCategory: number): Digest["sections"] {
  const by = new Map<Category, Item[]>();
  for (const it of items) {
    const list = by.get(it.category) ?? [];
    if (list.length < maxPerCategory) list.push(it);
    by.set(it.category, list);
  }
  return CATEGORY_ORDER.filter((c) => by.get(c)?.length).map((c) => ({ category: c, items: by.get(c)! }));
}

export interface BuildOptions {
  now?: number;
  sources?: Source[];
}

export async function buildDigest(env: Env, opts: BuildOptions = {}): Promise<Digest> {
  const now = opts.now ?? Date.now();
  // Monday covers the weekend and takes a full week of jobs news.
  const monday = new Date(now).getUTCDay() === 1;
  const windowHours = monday ? 72 : 24;
  const jobsWindowHours = monday ? 168 : 48;
  const maxPerCategory = Math.max(1, parseInt(env.MAX_PER_CATEGORY ?? "5", 10) || 5);

  const results = await Promise.all((opts.sources ?? SOURCES).map(fetchSource));
  const candidates = selectCandidates(results.flatMap((r) => r.items), now, windowHours, jobsWindowHours)
    .slice(0, MAX_CANDIDATES);

  const { items, topLine, claude } = await summarize(env, candidates, maxPerCategory);

  const anySourceOk = results.some((r) => r.status.ok);

  return {
    generatedAt: now,
    windowHours,
    topLine: anySourceOk ? topLine : "None of the news sources could be reached, so there is nothing to show. See the status below.",
    sections: toSections(items, maxPerCategory),
    sources: results.map((r) => r.status),
    claude,
  };
}
