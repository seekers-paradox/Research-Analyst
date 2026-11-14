import { CATEGORY_LABELS, type Digest } from "./types";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function claudeLine(d: Digest): string {
  if (d.claude.state === "ok") return "Claude: working. Summaries written by Claude.";
  if (d.claude.state === "off") return "Claude: not connected. Showing headlines only.";
  return `Claude: not working (${d.claude.detail ?? "unknown error"}). Showing headlines only.`;
}

export function sourcesLine(d: Digest): string {
  const failed = d.sources.filter((s) => !s.ok);
  const ok = d.sources.length - failed.length;
  const base = `Sources: ${ok} of ${d.sources.length} responded.`;
  return failed.length ? `${base} Not responding: ${failed.map((s) => s.name).join(", ")}.` : base;
}

const period = (d: Digest) => (d.windowHours > 24 ? `last ${Math.round(d.windowHours / 24)} days` : "last 24 hours");

/** Google Chat card message (https://developers.google.com/workspace/chat/api/reference/rest/v1/cards). */
export function renderChat(d: Digest, pageUrl?: string): unknown {
  const sections: unknown[] = [{ widgets: [{ textParagraph: { text: esc(d.topLine) } }] }];
  for (const s of d.sections) {
    sections.push({
      header: CATEGORY_LABELS[s.category],
      widgets: s.items.map((it) => ({
        textParagraph: {
          text:
            `<b><a href="${esc(it.url)}">${esc(it.title)}</a></b><br>` +
            (it.why ? `${esc(it.why)}<br>` : "") +
            `<font color="#80868b">${esc(it.source)}</font>`,
        },
      })),
    });
  }
  const footer: unknown[] = [{ textParagraph: { text: `<font color="#80868b">${esc(claudeLine(d))}<br>${esc(sourcesLine(d))}</font>` } }];
  if (pageUrl) footer.push({ buttonList: { buttons: [{ text: "Open full digest", onClick: { openLink: { url: pageUrl } } }] } });
  sections.push({ header: "Status", widgets: footer });

  return {
    cardsV2: [
      {
        cardId: "ai-news-digest",
        card: { header: { title: "AI News Digest", subtitle: `${dateLabel(d.generatedAt)} · ${period(d)}` }, sections },
      },
    ],
  };
}

export async function postToChat(webhookUrl: string, d: Digest, pageUrl?: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(renderChat(d, pageUrl)),
  });
  if (!res.ok) throw new Error(`Google Chat returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function renderHtml(d: Digest): string {
  const sections = d.sections
    .map(
      (s) => `<section><h2>${esc(CATEGORY_LABELS[s.category])}</h2><ul>${s.items
        .map(
          (it) =>
            `<li><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` +
            (it.why ? `<p>${esc(it.why)}</p>` : "") +
            `<small>${esc(it.source)}</small></li>`,
        )
        .join("")}</ul></section>`,
    )
    .join("");
  const failed = d.sources.filter((s) => !s.ok);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI News Digest</title><meta name="robots" content="noindex">
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6862;--line:#e4e1da;--accent:#b4512e;--ok:#2f7d4f;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#171614;--fg:#eceae4;--muted:#a09c94;--line:#33312d;--accent:#e58a63;--ok:#6fc08d;--bad:#f2857d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}.sub{color:var(--muted);margin:0 0 20px}
.top{font-size:18px;border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:0 0 28px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:6px;margin:28px 0 4px}
ul{list-style:none;margin:0;padding:0}li{padding:12px 0;border-bottom:1px solid var(--line)}
li a{color:var(--fg);font-weight:600;text-decoration:none;overflow-wrap:anywhere}li a:hover{color:var(--accent);text-decoration:underline}
li p{margin:4px 0 2px}small{color:var(--muted)}
.status{margin-top:36px;padding:14px 16px;border:1px solid var(--line);border-radius:8px;font-size:14px;color:var(--muted)}
.status b.ok{color:var(--ok)}.status b.bad{color:var(--bad)}.status p{margin:2px 0}
</style></head><body><main>
<h1>AI News Digest</h1><p class="sub">${esc(dateLabel(d.generatedAt))} · ${esc(period(d))}</p>
<p class="top">${esc(d.topLine)}</p>
${sections || "<p>No items in this period.</p>"}
<div class="status">
<p><b class="${d.claude.state === "ok" ? "ok" : "bad"}">${d.claude.state === "ok" ? "●" : "○"}</b> ${esc(claudeLine(d))}</p>
<p><b class="${failed.length ? "bad" : "ok"}">${failed.length ? "○" : "●"}</b> ${esc(sourcesLine(d))}</p>
<p>Generated ${esc(new Date(d.generatedAt).toISOString().slice(0, 16).replace("T", " "))} UTC.</p>
</div></main></body></html>`;
}
