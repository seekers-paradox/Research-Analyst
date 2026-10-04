const $ = (id) => document.getElementById(id);
const form = $("intake");
const state = { config: null, accessCode: "", running: false, dossier: "", sections: [], businessName: "" };

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

// Retries a step once, except for errors that will not fix themselves.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if ([400, 401, 402, 429].includes(err.status)) throw err;
    return fn();
  }
}

// ---------- research pipeline ----------

const SUBPAGE_HINTS = /about|service|product|menu|pricing|price|team|staff|contact|location|career|jobs|faq|review|testimonial|blog/i;

function pickSubpages(home, limit) {
  const scored = home.links
    .filter((l) => SUBPAGE_HINTS.test(l.url) || SUBPAGE_HINTS.test(l.text))
    .filter((l) => new URL(l.url).pathname.replace(/\/$/, "") !== new URL(home.url).pathname.replace(/\/$/, ""));
  const seen = new Set();
  const picked = [];
  for (const l of scored) {
    const key = (l.url.match(SUBPAGE_HINTS) || l.text.match(SUBPAGE_HINTS) || [""])[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(l);
    if (picked.length >= limit) break;
  }
  return picked;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseCompetitors(text, ownHost) {
  const list = [];
  const hosts = new Set([ownHost]);
  for (const line of text.split("\n")) {
    const parts = line.replace(/^[\s*\-\d.)]+/, "").split("|").map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) continue;
    let url = null;
    if (/^https?:\/\//i.test(parts[1])) {
      const host = hostOf(parts[1]);
      if (host && !hosts.has(host)) {
        hosts.add(host);
        url = parts[1];
      } else if (host) continue;
    }
    list.push({ name: parts[0].replace(/\*\*/g, ""), url, reason: parts[2] || "" });
    if (list.length >= 6) break;
  }
  return list;
}

async function readPage(url, label, maxText) {
  try {
    const page = await withRetry(() => api("/api/page", { url }));
    log(`Read ${label}: ${page.url}`);
    return { ...page, label, text: page.text.slice(0, maxText), links: undefined };
  } catch (err) {
    log(`Skipped ${label}: ${err.message}`, "warn");
    return null;
  }
}

async function runSearch(query) {
  try {
    const { results } = await withRetry(() => api("/api/search", { query }));
    log(`Searched “${query}”: ${results.length} results`);
    return { query, results };
  } catch (err) {
    log(`Search “${query}” failed: ${err.message}`, "warn");
    return { query, results: [] };
  }
}

async function run(intake) {
  state.running = true;
  state.dossier = "";
  state.sections = [];
  state.businessName = intake.businessName;
  const where = [intake.city, intake.state].filter(Boolean).join(" ");
  const pages = [];

  // 1. The business's own website.
  setPhase("Reading your website…", 0.03);
  const home = await withRetry(() => api("/api/page", { url: intake.website })).catch((err) => {
    log(`Could not read the website: ${err.message}`, "warn");
    return null;
  });
  if (home) {
    log(`Read website: ${home.url}`);
    pages.push({ ...home, label: "Business website (home)", text: home.text.slice(0, 10000), links: undefined });
    const subpages = pickSubpages(home, 4);
    const read = await pool(subpages, 4, (l) => readPage(l.url, "Business website", 6000));
    pages.push(...read.filter(Boolean));
  }

  // 2. Search for the business, its market, and named competitors.
  const named = (intake.knownCompetitors || "").split(/\n|,|;/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const isUrl = (s) => /^https?:|^[\w-]+(\.[\w-]+)+(\/|$)/i.test(s);
  let searches = [];
  if (state.config.searchProvider === "none") {
    log("Web search is not configured, so competitors come from your list only.", "warn");
  } else {
    setPhase("Searching the web…", 0.12);
    const queries = [
      `${intake.businessName} ${intake.city}`,
      `${intake.businessName} reviews`,
      `best ${intake.category} in ${where}`,
      `${intake.category} ${where}`,
      `${intake.businessName} jobs careers`,
      ...named.slice(0, 3).map((c) => (isUrl(c) ? c : `${c} ${intake.city}`)),
    ];
    searches = await pool(queries, 3, runSearch);
  }

  // 3. Identify competitors and read their websites.
  let competitors = named.map((c) => (isUrl(c) ? { name: hostOf(/^https?:/i.test(c) ? c : `https://${c}`), url: /^https?:/i.test(c) ? c : `https://${c}` } : { name: c, url: null }));
  if (searches.some((s) => s.results.length)) {
    setPhase("Identifying competitors…", 0.25);
    try {
      const text = await withRetry(() => aiStream({ task: "competitors", intake, searches }));
      const found = parseCompetitors(text, hostOf(home?.url || intake.website));
      const known = new Set(competitors.map((c) => hostOf(c.url || "") || c.name.toLowerCase()));
      competitors.push(...found.filter((c) => !known.has(hostOf(c.url || "") || c.name.toLowerCase())));
    } catch (err) {
      if ([401, 402, 429].includes(err.status)) throw err;
      log(`Could not identify competitors: ${err.message}`, "warn");
    }
  }
  log(`Competitors: ${competitors.map((c) => c.name).join(", ") || "none identified"}`);
  setPhase("Reading competitor websites…", 0.32);
  const withSites = competitors.filter((c) => c.url).slice(0, 5);
  const compPages = await pool(withSites, 4, (c) => readPage(c.url, `Competitor: ${c.name}`, 5000));
  pages.push(...compPages.filter(Boolean));

  // 4. Research dossier.
  setPhase("Writing the research dossier…", 0.4);
  showOutput("dossier");
  state.dossier = cleanMarkdown(
    await withRetry(() => aiStream({ task: "dossier", intake, pages, searches }, (t) => scheduleRender($("dossier"), t))),
  );
  render($("dossier"), state.dossier);
  log("Research dossier complete.");

  // 5. Playbook sections, a few at a time.
  const plan = [
    { section: "overview", title: "Overview" },
    ...intake.aiEmployees.map((role) => ({ section: "role", role, title: state.config.aiEmployees[role] })),
    { section: "operations", title: "Operations plan" },
  ];
  const report = $("report");
  report.innerHTML = "";
  const slots = plan.map((step, i) => {
    if (step.section === "role" && plan[i - 1].section !== "role") {
      const h = document.createElement("h2");
      h.textContent = "AI employee playbooks";
      report.appendChild(h);
    }
    const div = document.createElement("div");
    div.className = "pending";
    div.textContent = `Waiting: ${step.title}…`;
    report.appendChild(div);
    return div;
  });
  selectTab("report");

  let finished = 0;
  setPhase(`Writing the playbook (0 of ${plan.length} sections)…`, 0.5);
  state.sections = await pool(plan, 3, async (step, i) => {
    slots[i].className = "";
    const text = await withRetry(() =>
      aiStream({ task: "section", intake, dossier: state.dossier, section: step.section, role: step.role }, (t) =>
        scheduleRender(slots[i], t),
      ),
    ).catch((err) => {
      if ([401, 402, 429].includes(err.status)) throw err;
      log(`Section “${step.title}” failed: ${err.message}`, "warn");
      return `### ${step.title}\n\n_This section could not be generated: ${err.message}_`;
    });
    const md = cleanMarkdown(text);
    render(slots[i], md);
    finished++;
    log(`Finished: ${step.title}`);
    setPhase(`Writing the playbook (${finished} of ${plan.length} sections)…`, 0.5 + (0.5 * finished) / plan.length);
    return { ...step, markdown: md };
  });

  setPhase("Report ready", 1);
  $("download").disabled = false;
  $("print").disabled = false;
  state.running = false;
}

function fullMarkdown() {
  const parts = [];
  state.sections.forEach((s, i) => {
    if (s.section === "role" && state.sections[i - 1]?.section !== "role") parts.push("## AI employee playbooks");
    parts.push(s.markdown);
  });
  return `${parts.join("\n\n")}\n\n---\n\n# Appendix: Research dossier\n\n${state.dossier}\n`;
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

// ---------- UI wiring ----------

function selectTab(name) {
  const report = name === "report";
  $("report").hidden = !report;
  $("dossier").hidden = report;
  $("tab-report").setAttribute("aria-selected", String(report));
  $("tab-dossier").setAttribute("aria-selected", String(!report));
}

function showOutput(tab) {
  $("output").hidden = false;
  selectTab(tab);
}

$("tab-report").addEventListener("click", () => selectTab("report"));
$("tab-dossier").addEventListener("click", () => selectTab("dossier"));

async function loadConfig() {
  state.config = await fetch("/api/config").then((r) => r.json());
  $("employees").innerHTML = Object.entries(state.config.aiEmployees)
    .map(([id, label]) => `<label><input type="checkbox" name="aiEmployees" value="${id}" checked> ${label}</label>`)
    .join("");
  if (state.config.accessCodeRequired) {
    $("access-code-field").hidden = false;
    form.accessCode.value = storage((s) => s.getItem("accessCode")) || "";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.running) return;
  const data = Object.fromEntries(new FormData(form));
  data.aiEmployees = [...form.querySelectorAll("input[name=aiEmployees]:checked")].map((el) => el.value);
  state.accessCode = data.accessCode || "";
  delete data.accessCode;

  const missing = [...form.querySelectorAll("[required]")].filter((el) => !el.value.trim());
  if (missing.length) {
    showErrors(missing.map((el) => `${el.parentElement.firstChild.textContent.replace("*", "").trim()} is required.`));
    missing[0].focus();
    return;
  }
  if (data.aiEmployees.length === 0) return showErrors(["Choose at least one AI employee."]);

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

  // The server normalizes the website (adds https://); mirror that here.
  if (!/^https?:\/\//i.test(data.website)) data.website = `https://${data.website.trim()}`;

  form.hidden = true;
  $("progress").hidden = false;
  $("output").hidden = true;
  $("log").innerHTML = "";
  $("report").innerHTML = "";
  $("dossier").innerHTML = "";
  $("download").disabled = true;
  $("print").disabled = true;
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

$("download").addEventListener("click", () => {
  const blob = new Blob([fullMarkdown()], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.businessName || "report").replace(/[^a-z0-9]+/gi, "-")}-ai-playbook.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("print").addEventListener("click", () => {
  selectTab("report");
  $("dossier").hidden = false; // include the dossier as an appendix when printing
  window.print();
  $("dossier").hidden = true;
});

$("restart").addEventListener("click", () => {
  if (state.running && !confirm("A report is still being written. Start over anyway?")) return;
  location.reload();
});

window.addEventListener("beforeunload", (e) => {
  if (state.running) e.preventDefault();
});

loadConfig();
