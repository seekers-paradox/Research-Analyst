# Research-Analyst

A web app that researches a business and its competitors, then writes a detailed **AI Employee Playbook**: how each of the business's AI employees (social media, blog, SEO, HR, data analyst, support, sales, email, reputation) should work, what information they need, what they should ask the owner, and how to measure success.

## How it works

1. **Intake form**: the owner enters the business details (see below).
2. **Research**: Claude uses web search and web fetch to study the business's website, listings, reviews, and social profiles, then finds and analyzes 3–6 real competitors. The result is a research dossier with sources.
3. **Report**: Claude turns the dossier into the playbook and streams it to the browser. You can download it as Markdown or print/save it as PDF. A copy is also saved in `reports/` on the server.

## Information collected

| Section | Fields | Why it's needed |
|---|---|---|
| Business identity *(required)* | Business name, website, category | Finds the business online and frames the competitor search |
| Location | Street address, **city** *(required)*, state/province, postal code, **country** *(required)*, service area | Finds local competitors and localizes search results |
| Contact & presence | Phone, email, Google Business listing, social profiles | Lets the research audit the right profiles |
| About the business | What it does, products/services, target customers, known competitors, years in business, team size, revenue range, 12-month goals, challenges, brand voice, tools in use | Makes the recommendations specific instead of generic |
| AI employees | Choose which roles to plan for | Sets which playbook sections are written |

## What the report contains

- Executive summary and a business-vs-competitors comparison
- **Growth intelligence**: which information streams to monitor (competitor pricing, review themes, search demand, seasonality…) and why
- **One playbook per AI employee**: mission, responsibilities, information it needs, questions to ask the owner, how it should work, concrete examples, KPIs, and guardrails
  - Social media: platforms, posting cadence, content pillars, a 2-week calendar, sample posts
  - Blog: topic clusters, 10 sample titles with keywords, article structure
  - HR: likely roles, job description templates, screening questions, onboarding checklist
  - Data analyst: KPI dashboard, data sources, the exact data to request, reporting cadence
- How the AI employees hand work to each other
- Master onboarding checklist of everything the owner must provide
- 30/60/90-day rollout plan, risks, and guardrails

## Setup

Requires Node.js 20.12 or newer and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env   # then put your key in ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

Optional environment variables: `PORT` (default 3000) and `CLAUDE_MODEL` (default `claude-opus-5-5`).

## Cost and time

Each report runs up to about 25 web searches and 20 page fetches, followed by a long report-writing step. Expect 3–10 minutes per report. Cost depends on how much the model reads and writes. Web search is billed per search on top of tokens.

## Project layout

```
server.js          Express server, job store, server-sent events progress stream
src/intake.js      Intake fields, validation, AI employee roles
src/prompts.js     Research and report prompts
src/pipeline.js    Claude API calls (web research, then report writing)
public/            Intake form and report viewer
```

## Notes

- Jobs are kept in memory, so restarting the server clears in-progress jobs. Finished reports remain in `reports/`.
- There is no login, so don't expose the server publicly as is. Anyone who can reach it can spend your API credits.
- If a safety classifier declines a request, the app opts into the API's server-side fallback (`fallbacks: "default"`), which retries on a recommended fallback model.
