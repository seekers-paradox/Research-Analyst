# Research-Analyst

A Cloudflare Worker that researches a business and its competitors, then writes a detailed **AI Employee Playbook**: how each of the business's AI employees (social media, blog, SEO, HR, data analyst, support, sales, email, reputation) should work, what information they need, what they should ask the owner, and how to measure success.

**Live:** https://research-analyst.dayeshp.workers.dev

It runs entirely on Cloudflare: the page is served as Workers static assets, and the writing is done by a [Workers AI](https://developers.cloudflare.com/workers-ai/) model (default `@cf/openai/gpt-oss-120b`).

## How it works

1. **Intake form**: the owner enters the business details (see below).
2. **Research**: the Worker reads the business's website (home, About, Services, Jobs, Contact pages), runs web searches if a search key is configured, picks competitors, and reads their websites.
3. **Research dossier**: Workers AI summarizes everything gathered, with sources.
4. **Playbook**: Workers AI writes the report section by section (overview, one section per AI employee, operations plan), streaming into the page. Download it as Markdown or print/save it as PDF.

The browser runs these steps as a series of small Worker requests. That keeps each request inside the Workers Free plan limits (about 10 ms CPU and 50 subrequests per request). AI output streams straight through the Worker without being parsed.

## Information collected

| Section | Fields | Why it's needed |
|---|---|---|
| Business identity *(required)* | Business name, website, category | Finds the business online and frames the competitor search |
| Location | Street address, **city** *(required)*, state/province, postal code, **country** *(required)*, service area | Finds local competitors |
| Contact & presence | Phone, email, Google Business listing, social profiles | Lets the research audit the right profiles |
| About the business | What it does, products/services, target customers, known competitors, years in business, team size, revenue range, 12-month goals, challenges, brand voice, tools in use | Makes the recommendations specific instead of generic |
| AI employees | Choose which roles to plan for | Sets which playbook sections are written |

## What the report contains

- Executive summary and a business-vs-competitors comparison
- **Growth intelligence**: which information streams to monitor and why
- **One playbook per AI employee**: mission, responsibilities, information it needs, questions to ask the owner, how it should work, examples, KPIs, guardrails
- How the AI employees work together, a master onboarding checklist, a 30/60/90-day rollout plan, and risks
- Appendix: the research dossier with sources

## Configuration

| Setting | Where | Purpose |
|---|---|---|
| `AI_MODEL` | `vars` in `wrangler.jsonc` | Workers AI model. `@cf/openai/gpt-oss-120b` works on the Free plan. Stronger models such as `@cf/zai-org/glm-5.3` or `@cf/deepseek-ai/deepseek-v4-pro-0813` need the Workers Paid plan. |
| `REASONING_EFFORT` | `vars` (optional) | `low` (default), `medium`, or `high` for gpt-oss models. Higher means better reasoning but more neurons. |
| `BRAVE_API_KEY` | secret (optional, recommended) | Enables web search so competitors are found automatically. Get a key at https://brave.com/search/api/. Without it, competitors come only from the owner's "Known competitors" list. Free search-engine result pages block or degrade requests from Cloudflare. |
| `ACCESS_CODE` | secret (optional) | When set, the form asks for this code before running. Use it to stop strangers from spending your Workers AI quota. |

Set a secret with `npx wrangler secret put BRAVE_API_KEY`, or in the Cloudflare dashboard under **Workers & Pages → research-analyst → Settings → Variables and Secrets**.

## Develop and deploy

```bash
npm install
npx wrangler login        # or set CLOUDFLARE_API_TOKEN
npm run dev               # local dev; the AI binding calls Cloudflare remotely
npm run deploy            # deploys to https://research-analyst.<your-subdomain>.workers.dev
```

For local secrets, copy `.dev.vars.example` to `.dev.vars`.

## Cost and limits

A full report (all nine AI employees) makes about 13 Workers AI calls. With gpt-oss-120b at low reasoning effort that is roughly 3,000–5,000 neurons. The Free plan includes 10,000 neurons per day, so expect about 2–3 full reports per day for free. Choosing fewer AI employees uses less. On the Paid plan, extra usage is billed at $0.011 per 1,000 neurons, about 5 cents per report.

## Project layout

```
wrangler.jsonc       Worker config: static assets, Workers AI binding, model
src/worker.js        API routes: /api/config, /api/validate, /api/page, /api/search, /api/ai
src/web.js           Page fetching and text extraction, Brave web search
src/prompts.js       Prompts for competitor selection, dossier, and report sections
src/intake.js        Intake fields, validation, AI employee roles
public/              Intake form, report viewer, and vendored marked + DOMPurify
```

## Notes

- Reports live only in the browser tab. Download before closing it.
- Some websites block automated requests or load their content with JavaScript, so less text can be extracted from them. The log shows which pages were skipped.
