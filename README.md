# Research-Analyst

A Cloudflare Worker that turns four details (business name, website, category, city) into a short **AI Employee Onboarding Report** for the client to review. It covers three AI employees:

- **AI Receptionist** (webchat, voice, SMS)
- **AI Social Media** (writes social posts)
- **AI Blogger** (writes blog posts for the website)

**Live:** https://research-analyst.dayeshp.workers.dev

## The report

1. **What we found about your business**: offer, customers, contact details, reputation, online presence, and the gaps that matter.
2. **Your competitors nearby**: a table showing each competitor, its rating, what it does well, and where the client can stand out.
3. **Your AI employees**: for each one, what it will do, **what it should collect from customers and why**, and **which integrations it needs**.
4. **Please review**: specific questions for the client to confirm or correct, plus **what we need from you** (access, information, content).

A report is usually 4–6 pages and takes under a minute. Use **Edit report** to adjust it before downloading it or saving it as PDF for the client. The client's corrections then feed into onboarding.

## How the research works

| Step | Source |
|---|---|
| Read the business website | The Worker fetches the home page plus About, Services, Contact, and similar pages |
| Find the business's Google listing (rating, review count, hours) | [SerpApi](https://serpapi.com/google-maps-api) Google Maps search for "*name* *city*" |
| Read its recent Google reviews | SerpApi Google Maps Reviews |
| Find nearby competitors | SerpApi Google Maps search for "*category* in *city*" (the same results you see on Google Maps), then reads the top competitors' websites |
| Without a SerpApi key | The AI suggests competitors, marked "suggested, please confirm", with ratings shown as "Not checked" |
| Write the report | Workers AI (`AI_MODEL`, default `@cf/openai/gpt-oss-120b`): 5 calls per report |

## Adding more AI employees

The covered roles are listed in `AI_EMPLOYEES` in `src/intake.js`, and each has a brief in `ROLE_BRIEFS` in `src/prompts.js`. To cover another AI employee, add one entry to each. The report adds a section for it automatically.

## Configuration

| Setting | Where | Purpose |
|---|---|---|
| `SERPAPI_KEY` | secret (recommended) | Finds the business's Google Maps listing, its reviews, and nearby competitors with real ratings and review counts. Get a key at https://serpapi.com/manage-api-key. |
| `ACCESS_CODE` | secret (optional) | When set, the form asks for this code before running. |
| `AI_MODEL` | `vars` in `wrangler.jsonc` | Workers AI model. `@cf/openai/gpt-oss-120b` works on the Free plan. Stronger models need the Workers Paid plan. |
| `REASONING_EFFORT` | `vars` (optional) | `low` (default), `medium`, or `high` for gpt-oss models. |

Set a secret with `npx wrangler secret put SERPAPI_KEY`, or in the Cloudflare dashboard under **Workers & Pages → research-analyst → Settings → Variables and Secrets**.

## Develop and deploy

```bash
npm install
npx wrangler login        # or set CLOUDFLARE_API_TOKEN
npm run dev               # local dev; the AI binding calls Cloudflare remotely
npm run deploy            # deploys to https://research-analyst.<your-subdomain>.workers.dev
```

For local secrets, copy `.dev.vars.example` to `.dev.vars`.

## Cost and limits

Each report makes 5 Workers AI calls, far fewer than the earlier long-form version. The Workers Free plan includes 10,000 neurons per day; on the Paid plan extra usage costs $0.011 per 1,000 neurons. Each report uses up to 3 SerpApi searches (business listing, its reviews, nearby competitors), counted against your SerpApi plan's monthly search allowance.

## Project layout

```
wrangler.jsonc       Worker config: static assets, Workers AI binding, model
src/worker.js        API routes: /api/config, /api/validate, /api/page, /api/local, /api/reviews, /api/ai
src/web.js           Page fetching and text extraction, SerpApi Google Maps search and reviews
src/prompts.js       Prompts for findings, AI employee briefs, and the review checklist
src/intake.js        The four intake fields, validation, and the AI employees covered
public/              Form, report viewer and editor, vendored marked + DOMPurify
```

## Notes

- Reports live only in the browser tab. Download before closing it.
- Some websites block automated requests or load their content with JavaScript, so less text can be extracted from them. The log shows which pages were skipped.
