const $ = (id) => document.getElementById(id);
const form = $("intake");
const state = { config: null, accessCode: "", running: false, markdown: "", businessName: "", editing: false };

// ---------- small helpers ----------

function storage(fn) {
  try {
    return fn(window.localStorage);
  } catch {
    return null;
  }
}

function render(el, markdown) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
}

function cleanMarkdown(text) {
  return text.replace(/^\s*```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
}

function log(message, kind = "") {
  const li = document.createElement("li");
  li.textContent = message;
  if (kind) li.className = kind;
  $("log").appendChild(li);
  $("log").scrollTop = $("log").scrollHeight;
}

function setPhase(message, progress) {
  $("phase").textContent = message;
  if (progress != null) $("bar-fill").style.width = `${Math.round(progress * 100)}%`;
}

function showErrors(errors) {
  const list = $("form-errors");
  list.innerHTML = "";
  for (const e of errors) {
    const li = document.createElement("li");
    li.textContent = e;
    list.appendChild(li);
  }
  list.hidden = errors.length === 0;
}

function hostOf(url) {
  try {
    return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function simplify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(the|inc|llc|co|ltd)\b/g, "").trim();
}

// Runs async tasks with a concurrency limit, preserving result order.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Errors that will not fix themselves on retry, and stop the whole report.
const FATAL = [400, 401, 402, 429];

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (FATAL.includes(err.status)) throw err;
    return fn();
  }
}

// ---------- API calls ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": state.accessCode },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (data.errors || []).join(" ") || `HTTP ${res.status}`);
    err.status = res.status;
    err.errors = data.errors;
    throw err;
  }
  return data;
}

// Calls a Workers AI step and streams the generated text to onText.
async function aiStream(body, onText = () => {}) {
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Code": state.accessCode },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `AI step failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        // Workers AI models use either a { response } or an OpenAI-style chunk.
        const delta = typeof event.response === "string" ? event.response : event.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          text += delta;
          onText(text);
        }
      } catch {
        // partial or non-JSON line
      }
    }
  }
  if (!text.trim()) throw new Error("The AI model returned an empty response.");
  return text;
}

// Re-rendering on every streamed token is slow; batch to animation frames.
const pendingRenders = new Map();
function scheduleRender(el, markdown) {
  const queued = pendingRenders.has(el);
  pendingRenders.set(el, markdown);
  if (queued) return;
  requestAnimationFrame(() => {
    render(el, cleanMarkdown(pendingRenders.get(el)));
    pendingRenders.delete(el);
  });
}

// ---------- research ----------

const SUBPAGE_HINTS = /about|service|product|menu|pricing|price|contact|faq|book|appointment|location/i;

function pickSubpages(home, limit) {
  const homePath = new URL(home.url).pathname.replace(/\/$/, "");
  const seen = new Set();
  const picked = [];
  for (const l of home.links) {
    const hit = l.url.match(SUBPAGE_HINTS) || l.text.match(SUBPAGE_HINTS);
    if (!hit || new URL(l.url).pathname.replace(/\/$/, "") === homePath) continue;
    const key = hit[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(l);
    if (picked.length >= limit) break;
  }
  return picked;
}

async function readPage(url, label, maxText) {
  try {
    const page = await withRetry(() => api("/api/page", { url }));
    log(`Read ${label}: ${page.url}`);
    return { ...page, text: page.text.slice(0, maxText) };
  } catch (err) {
    log(`Skipped ${label}: ${err.message}`, "warn");
    return null;
  }
}

async function readWebsite(intake) {
  setPhase("Reading the website…", 0.05);
  const home = await readPage(intake.website, "website", 8000);
  if (!home) return { home: null, pages: [] };
  const subpages = await pool(pickSubpages(home, 3), 3, (l) => readPage(l.url, "page", 4000));
  const strip = ({ links, ...page }) => page;
  return { home, pages: [home, ...subpages.filter(Boolean)].map(strip) };
}

// SerpApi Google Maps search: the business's own listing and reviews, plus
// nearby businesses in the same category with ratings and review counts.
async function findWithSerpApi(intake, ownHost) {
  setPhase("Looking up the business on Google Maps…", 0.2);
  const isSelf = (p) => (ownHost && hostOf(p.website) === ownHost) || simplify(p.name) === simplify(intake.businessName);

  let business = null;
  try {
    const { places } = await withRetry(() => api("/api/local", { query: `${intake.businessName} ${intake.city}`, limit: 5 }));
    business = places.find(isSelf) || null;
    log(business ? `Found listing: ${business.name} (${business.rating ?? "no"}★, ${business.reviewCount} reviews)` : "No Google Maps listing matched the business.", business ? "" : "warn");
  } catch (err) {
    if (FATAL.includes(err.status)) throw err;
    log(err.message, "warn");
  }
  if (business?.dataId && business.reviewCount > 0 && business.reviews.length < 3) {
    try {
      const { reviews } = await withRetry(() => api("/api/reviews", { dataId: business.dataId }));
      business.reviews = reviews;
      log(`Read ${reviews.length} recent reviews.`);
    } catch (err) {
      if (FATAL.includes(err.status)) throw err;
      log(err.message, "warn");
    }
  }

  setPhase("Finding nearby competitors…", 0.28);
  let competitors = [];
  try {
    const { places } = await withRetry(() => api("/api/local", { query: `${intake.category} in ${intake.city}`, limit: 12 }));
    competitors = places.filter((p) => !isSelf(p) && p.status !== "CLOSED_PERMANENTLY").slice(0, 5);
    log(`Nearby competitors: ${competitors.map((c) => c.name).join(", ") || "none found"}`);
  } catch (err) {
    if (FATAL.includes(err.status)) throw err;
    log(err.message, "warn");
  }

  setPhase("Reading competitor websites…", 0.33);
  await pool(competitors.filter((c) => c.website).slice(0, 3), 3, async (c) => {
    const page = await readPage(c.website, `competitor ${c.name}`, 2500);
    if (page) c.siteText = [page.title, page.description, page.text].filter(Boolean).join(" — ").slice(0, 2500);
  });
  return { business, competitors };
}

// ---------- report ----------

function reportHeader(intake) {
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return `# AI Employee Onboarding Report: ${intake.businessName}

_${intake.category} · ${intake.city} · ${hostOf(intake.website)} · ${date}_

> This report shows what we found about your business and how we plan to set up your AI Receptionist, AI Social Media, and AI Blogger. Please review it and tell us what is wrong or missing. Your answers shape how your AI employees work.`;
}

async function run(intake) {
  state.running = true;
  state.businessName = intake.businessName;
  const ownHost = hostOf(intake.website);

  // 1. Research.
  const { home, pages } = await readWebsite(intake);
  let found = { business: null, competitors: [] };
  if (state.config.localSearch) found = await findWithSerpApi(intake, hostOf(home?.url || "") || ownHost);
  else log("Local search (SerpApi) is not configured, so competitors will be suggested by the AI for the client to confirm.", "warn");

  // 2. Build the report on the page section by section.
  const report = $("report");
  report.innerHTML = "";
  const header = reportHeader(intake);
  const addSlot = (label) => {
    const div = document.createElement("div");
    div.className = "pending";
    div.textContent = `Waiting: ${label}…`;
    report.appendChild(div);
    return div;
  };
  render(addSlot(""), header);
  const findingsSlot = addSlot("What we found");
  const rolesHeading = document.createElement("h2");
  rolesHeading.textContent = "Your AI employees";
  report.appendChild(rolesHeading);
  const roles = Object.entries(state.config.aiEmployees);
  const roleSlots = roles.map(([, label]) => addSlot(label));
  const reviewSlot = addSlot("Please review");
  report.firstElementChild.className = "";
  $("output").hidden = false;

  const write = async (slot, body, label) => {
    slot.className = "";
    try {
      const text = await withRetry(() => aiStream(body, (t) => scheduleRender(slot, t)));
      const md = cleanMarkdown(text);
      render(slot, md);
      log(`Finished: ${label}`);
      return md;
    } catch (err) {
      if (FATAL.includes(err.status)) throw err;
      log(`${label} failed: ${err.message}`, "warn");
      const md = `_The “${label}” section could not be generated: ${err.message}_`;
      render(slot, md);
      return md;
    }
  };

  setPhase("Writing what we found…", 0.4);
  const findings = await write(findingsSlot, { task: "findings", intake, research: { ...found, pages } }, "What we found");

  setPhase("Planning the AI employees…", 0.6);
  const roleSections = await pool(roles, 3, ([role, label], i) =>
    write(roleSlots[i], { task: "role", intake, findings, role }, label),
  );

  setPhase("Writing the review checklist…", 0.85);
  const body = [findings, "## Your AI employees", ...roleSections].join("\n\n");
  const review = await write(reviewSlot, { task: "review", intake, report: body }, "Please review");

  state.markdown = [header, body, review].join("\n\n") + "\n";
  render(report, state.markdown);
  setPhase("Report ready", 1);
  for (const id of ["edit", "download", "print"]) $(id).disabled = false;
  state.running = false;
}

// ---------- UI wiring ----------

async function loadConfig() {
  state.config = await fetch("/api/config").then((r) => r.json());
  if (state.config.accessCodeRequired) {
    $("access-code-field").hidden = false;
    form.accessCode.value = storage((s) => s.getItem("accessCode")) || "";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.running) return;
  const data = Object.fromEntries(new FormData(form));
  state.accessCode = data.accessCode || "";
  delete data.accessCode;

  const missing = [...form.querySelectorAll("[required]")].filter((el) => !el.value.trim());
  if (missing.length) {
    showErrors(missing.map((el) => `${el.parentElement.firstChild.textContent.trim()} is required.`));
    missing[0].focus();
    return;
  }

  $("submit").disabled = true;
  try {
    await api("/api/validate", data);
  } catch (err) {
    $("submit").disabled = false;
    return showErrors(err.errors || [err.message]);
  }
  $("submit").disabled = false;
  showErrors([]);
  if (state.accessCode) storage((s) => s.setItem("accessCode", state.accessCode));
  if (!/^https?:\/\//i.test(data.website)) data.website = `https://${data.website.trim()}`;

  form.hidden = true;
  $("progress").hidden = false;
  $("output").hidden = true;
  $("log").innerHTML = "";
  for (const id of ["edit", "download", "print"]) $(id).disabled = true;
  window.scrollTo(0, 0);

  try {
    await run(data);
  } catch (err) {
    state.running = false;
    setPhase("Something went wrong");
    log(err.message, "error");
    form.hidden = false;
  }
});

$("edit").addEventListener("click", () => {
  state.editing = !state.editing;
  if (state.editing) {
    $("editor").value = state.markdown;
    $("editor").style.height = `${Math.max(400, $("report").offsetHeight)}px`;
  } else {
    state.markdown = $("editor").value;
    render($("report"), state.markdown);
  }
  $("editor").hidden = !state.editing;
  $("report").hidden = state.editing;
  $("edit").textContent = state.editing ? "Done editing" : "Edit report";
  $("download").disabled = $("print").disabled = state.editing;
});

$("download").addEventListener("click", () => {
  const blob = new Blob([state.markdown], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.businessName || "report").replace(/[^a-z0-9]+/gi, "-")}-onboarding-report.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("print").addEventListener("click", () => window.print());

$("restart").addEventListener("click", () => {
  if (state.running && !confirm("A report is still being written. Start over anyway?")) return;
  location.reload();
});

window.addEventListener("beforeunload", (e) => {
  if (state.running || state.editing) e.preventDefault();
});

loadConfig();
