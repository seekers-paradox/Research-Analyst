import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDigest, selectCandidates, toSections } from "../src/digest";
import { parseFeed, toText } from "../src/feeds";
import { renderChat, renderHtml } from "../src/render";
import { applyPicks } from "../src/summarize";
import type { Item, Source } from "../src/types";

const NOW = Date.parse("2026-11-12T13:00:00Z"); // a Thursday
const src: Source = { name: "Test", url: "https://example.com/feed", category: "tools", weight: 2 };

const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
<item><title><![CDATA[New model &amp; <b>pricing</b>]]></title><link>https://example.com/a?x=1&amp;y=2</link>
<pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;Cheaper &amp;amp; faster.&lt;/p&gt;</description></item>
<item><title>Old story</title><link>https://example.com/old</link><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://example.com/nodate</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><title type="html">Token costs &#8212; a study</title>
<link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/post"/>
<updated>2026-11-12T08:00:00Z</updated><summary>How to cut spend.</summary></entry></feed>`;

function item(over: Partial<Item>): Item {
  return { id: "x", title: "T", url: "https://e.com/x", source: "S", category: "tools", weight: 1, published: NOW - 3_600_000, snippet: "", ...over };
}

afterEach(() => vi.unstubAllGlobals());

describe("feed parsing", () => {
  it("reads RSS items, decoding CDATA and entities, and skips undated ones", async () => {
    const items = await parseFeed(RSS, src);
    expect(items.map((i) => i.title)).toEqual(["New model & pricing", "Old story"]);
    expect(items[0].url).toBe("https://example.com/a?x=1&y=2");
    expect(items[0].snippet).toBe("Cheaper & faster.");
    expect(items[0].id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("reads Atom entries and prefers the alternate link", async () => {
    const [it0] = await parseFeed(ATOM, src);
    expect(it0.title).toBe("Token costs — a study");
    expect(it0.url).toBe("https://example.com/post");
    expect(it0.published).toBe(Date.parse("2026-11-12T08:00:00Z"));
  });

  it("strips scripts and tags", () => {
    expect(toText("<p>Hi <script>alert(1)</script>there</p>")).toBe("Hi there");
  });
});

describe("selection", () => {
  it("drops old items, dedupes the same story, and ranks trusted sources first", () => {
    const out = selectCandidates(
      [
        item({ id: "a", title: "Big launch - TechSite", url: "https://e.com/a", weight: 1 }),
        item({ id: "b", title: "Big launch", url: "https://e.com/b", weight: 3 }),
        item({ id: "c", title: "Stale", url: "https://e.com/c", published: NOW - 30 * 3_600_000 }),
        item({ id: "d", title: "Jobs report", url: "https://e.com/d", category: "jobs", published: NOW - 30 * 3_600_000 }),
      ],
      NOW, 24, 48,
    );
    expect(out.map((i) => i.id)).toEqual(["b", "d"]);
  });

  it("caps each section and keeps the section order", () => {
    const items = [item({ id: "1", category: "jobs" }), item({ id: "2" }), item({ id: "3" }), item({ id: "4", category: "releases" })];
    const s = toSections(items, 1);
    expect(s.map((x) => [x.category, x.items.length])).toEqual([["releases", 1], ["tools", 1], ["jobs", 1]]);
  });
});

describe("Claude picks", () => {
  const cands = [item({ id: "a", url: "https://e.com/a" }), item({ id: "b", url: "https://e.com/b" })];

  it("keeps feed links and ignores unknown or repeated ids", () => {
    const { items, topLine } = applyPicks(cands, {
      top_line: "Busy day.",
      picks: [
        { id: "b", category: "research", why: "Matters." },
        { id: "b", category: "tools", why: "Dup." },
        { id: "zzz", category: "tools", why: "Invented." },
      ],
    });
    expect(topLine).toBe("Busy day.");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "b", url: "https://e.com/b", category: "research", why: "Matters." });
  });

  it("rejects a malformed response", () => {
    expect(() => applyPicks(cands, { picks: "nope" })).toThrow();
  });
});

describe("end to end without Claude", () => {
  it("builds a headline digest, reports the failing source, and renders both outputs", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("good") ? new Response(RSS) : new Response("down", { status: 503 }),
    );
    const d = await buildDigest({}, {
      now: NOW,
      sources: [{ ...src, name: "Good", url: "https://good.example/feed" }, { ...src, name: "Bad", url: "https://bad.example/feed" }],
    });
    expect(d.claude.state).toBe("off");
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0].items.map((i) => i.title)).toEqual(["New model & pricing"]);
    expect(d.sources).toEqual([
      { name: "Good", ok: true, items: 2 },
      { name: "Bad", ok: false, items: 0, error: "HTTP 503" },
    ]);

    const chat = JSON.stringify(renderChat(d));
    expect(chat).toContain("New model &amp; pricing");
    expect(chat).toContain("Claude: not connected");
    expect(chat).toContain("Not responding: Bad");

    const html = renderHtml(d);
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain("Sources: 1 of 2 responded.");
  });

  it("falls back to headlines when the Claude call fails", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return u.includes("anthropic.com")
        ? new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } })
        : new Response(RSS);
    });
    const d = await buildDigest({ ANTHROPIC_API_KEY: "sk-test" }, { now: NOW, sources: [src] });
    expect(d.claude).toMatchObject({ state: "failed", detail: "API key was rejected" });
    expect(d.sections[0].items).toHaveLength(1);
  });
});
