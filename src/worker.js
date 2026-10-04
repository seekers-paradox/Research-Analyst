import { AI_EMPLOYEES, validateIntake } from "./intake.js";
import { competitorsMessages, findingsMessages, reviewMessages, roleMessages } from "./prompts.js";
import { fetchPage, placesSearch, search } from "./web.js";

// The browser drives the research one small step at a time. Each step is its
// own Worker request, which keeps every request inside the Free plan's CPU
// and subrequest limits. AI output is streamed straight through to the
// browser without being parsed here.

const MAX_TOKENS = { competitors: 3000, findings: 5000, role: 5000, review: 3000 };

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

function authorized(request, env) {
  return !env.ACCESS_CODE || request.headers.get("X-Access-Code") === env.ACCESS_CODE;
}

function str(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function cleanPages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.slice(0, 8).map((p) => ({
    url: str(p?.url, 500),
    title: str(p?.title, 300),
    description: str(p?.description, 600),
    text: str(p?.text, 10_000),
    socials: Array.isArray(p?.socials) ? p.socials.slice(0, 12).map((s) => str(s, 300)) : [],
  }));
}

function cleanSearches(searches) {
  if (!Array.isArray(searches)) return [];
  return searches.slice(0, 10).map((s) => ({
    query: str(s?.query, 300),
    results: (Array.isArray(s?.results) ? s.results : []).slice(0, 8).map((r) => ({
      title: str(r?.title, 300),
      url: str(r?.url, 500),
      snippet: str(r?.snippet, 600),
    })),
  }));
}

function cleanPlace(p) {
  if (!p || typeof p !== "object" || !p.name) return null;
  return {
    name: str(p.name, 200),
    type: str(p.type, 100),
    address: str(p.address, 300),
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: Number.isFinite(p.reviewCount) ? p.reviewCount : 0,
    website: str(p.website, 300),
    phone: str(p.phone, 50),
    status: str(p.status, 50),
    hours: Array.isArray(p.hours) ? p.hours.slice(0, 7).map((h) => str(h, 100)) : [],
    reviews: (Array.isArray(p.reviews) ? p.reviews : []).slice(0, 5).map((r) => ({
      rating: typeof r?.rating === "number" ? r.rating : null,
      when: str(r?.when, 50),
      text: str(r?.text, 600),
    })),
    siteText: str(p.siteText, 3000),
  };
}

function buildMessages(body, intake) {
  switch (body.task) {
    case "competitors":
      return competitorsMessages(intake, cleanSearches(body.searches));
    case "findings": {
      const r = body.research ?? {};
      return findingsMessages(intake, {
        business: cleanPlace(r.business),
        competitors: (Array.isArray(r.competitors) ? r.competitors : []).slice(0, 6).map(cleanPlace).filter(Boolean),
        pages: cleanPages(r.pages),
        searches: cleanSearches(r.searches),
      });
    }
    case "role": {
      const findings = str(body.findings, 20_000);
      if (!findings) throw new Error("Missing findings");
      if (!(body.role in AI_EMPLOYEES)) throw new Error("Unknown AI employee");
      return roleMessages(intake, findings, body.role);
    }
    case "review": {
      const report = str(body.report, 60_000);
      if (!report) throw new Error("Missing report");
      return reviewMessages(intake, report);
    }
    default:
      throw new Error("Unknown task");
  }
}

async function runAi(body, env) {
  const { intake, errors } = validateIntake(body.intake);
  if (errors) return fail(errors.join(" "));

  let messages;
  try {
    messages = buildMessages(body, intake);
  } catch (err) {
    return fail(err.message);
  }

  const model = env.AI_MODEL || "@cf/openai/gpt-oss-120b";
  const input = { messages, stream: true, max_tokens: MAX_TOKENS[body.task] };
  if (/gpt-oss/.test(model)) input.reasoning_effort = env.REASONING_EFFORT || "low";

  try {
    const stream = await env.AI.run(model, input);
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (/4006|daily free allocation|neurons/i.test(message)) {
      return fail("The Workers AI daily free allowance is used up. Try again tomorrow or upgrade to the Workers Paid plan.", 429);
    }
    if (/5035|not available on the Workers Free plan/i.test(message)) {
      return fail(`The model ${model} needs the Workers Paid plan. Change AI_MODEL in wrangler.jsonc or upgrade.`, 402);
    }
    return fail(`Workers AI error: ${message}`, 502);
  }
}

async function handleApi(request, env, url) {
  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({
      aiEmployees: AI_EMPLOYEES,
      accessCodeRequired: Boolean(env.ACCESS_CODE),
      searchProvider: env.BRAVE_API_KEY ? "brave" : "none",
      placesEnabled: Boolean(env.GOOGLE_PLACES_API_KEY),
      model: env.AI_MODEL,
    });
  }

  if (request.method !== "POST") return fail("Not found", 404);
  if (!authorized(request, env)) return fail("Wrong or missing access code.", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }

  switch (url.pathname) {
    case "/api/validate": {
      const { errors } = validateIntake(body);
      return errors ? json({ errors }, 400) : json({ ok: true });
    }
    case "/api/page":
      try {
        return json(await fetchPage(body.url));
      } catch (err) {
        return fail(`Could not read ${str(body.url, 200)}: ${err.message}`, 502);
      }
    case "/api/search":
      try {
        return json(await search(body.query, env));
      } catch (err) {
        return fail(`Search failed: ${err.message}`, 502);
      }
    case "/api/places":
      try {
        const places = await placesSearch(body.query, env, { withReviews: body.withReviews === true, limit: Number(body.limit) || 8 });
        return json({ places });
      } catch (err) {
        return fail(`Local search failed: ${err.message}`, 502);
      }
    case "/api/ai":
      return runAi(body, env);
    default:
      return fail("Not found", 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
