# Research-Analyst

## AI News Digest (Cloudflare Worker)

A small Cloudflare Worker that collects AI news from a fixed list of feeds, groups
it into sections, and delivers it as:

- a web page at the Worker's address, and
- a Google Chat card on a schedule (once a webhook is added).

It runs on Cloudflare's schedule, so it does not depend on any Claude session
being open. Claude is used only to pick the best items and write a one-line
"why it matters" for each. If Claude is not connected or the call fails, the
digest still goes out as ranked headlines, and the Status block at the bottom
says whether Claude is working.

### Sections

Model & product releases · Research & benchmarks · Tools & techniques ·
Jobs & market · Industry news

Sources are listed in `src/sources.ts`. A source that fails is skipped and
named in the Status block; it never stops the digest.

### Deploy

You need a free Cloudflare account and Node 20+.

```bash
npm install
npx wrangler login
npx wrangler deploy
```

`deploy` prints the Worker's address (`https://ai-news-digest.<you>.workers.dev`).
Open it to see the digest.

### Optional settings

Each is a secret, set with `npx wrangler secret put <NAME>`:

| Secret | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on Claude's selection and "why it matters" lines. |
| `GOOGLE_CHAT_WEBHOOK_URL` | Posts the digest to that Google Chat space on schedule. |
| `DIGEST_TOKEN` | Any password you choose. Pages then need `?key=<token>`, and `/send` is enabled. |

Setting `DIGEST_TOKEN` is recommended once `ANTHROPIC_API_KEY` is set, because
loading the page can trigger a Claude call (at most once every 30 minutes per
Cloudflare location).

### Schedule

`wrangler.toml` sends at 13:00 UTC, Monday to Friday. Change the hour in
`crons` to suit your time zone and redeploy. Monday's digest covers the weekend
and a full week of jobs news.

### Addresses

| Path | Shows |
|---|---|
| `/` | The digest page |
| `/status` | Whether Claude is working and which sources responded (JSON) |
| `/api/digest` | The digest as JSON |
| `/send` | Sends to Google Chat now (needs `DIGEST_TOKEN`) |
| `/health` | Whether the Worker is up |

### Development

```bash
npm test          # unit tests
npm run typecheck
npm run dev       # local server; trigger the schedule at /__scheduled
```
