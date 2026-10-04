const $ = (id) => document.getElementById(id);
const form = $("intake");
const state = { id: null, report: "", dossier: "", businessName: "" };

function render(el, markdown) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
}

// Re-rendering the whole report on every streamed token is slow; batch to frames.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render($("report"), state.report);
  });
}

function log(message) {
  const li = document.createElement("li");
  li.textContent = message;
  $("log").appendChild(li);
}

async function loadEmployees() {
  const employees = await fetch("/api/ai-employees").then((r) => r.json());
  $("employees").innerHTML = Object.entries(employees)
    .map(([id, label]) => `<label><input type="checkbox" name="aiEmployees" value="${id}" checked> ${label}</label>`)
    .join("");
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.aiEmployees = [...form.querySelectorAll("input[name=aiEmployees]:checked")].map((el) => el.value);

  const missing = [...form.querySelectorAll("[required]")].filter((el) => !el.value.trim());
  if (missing.length) {
    showErrors(missing.map((el) => `${el.parentElement.firstChild.textContent.replace("*", "").trim()} is required.`));
    missing[0].focus();
    return;
  }

  $("submit").disabled = true;
  const res = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch(() => null);
  $("submit").disabled = false;

  if (!res) return showErrors(["Could not reach the server."]);
  const body = await res.json();
  if (!res.ok) return showErrors(body.errors || [body.error || "Something went wrong."]);

  showErrors([]);
  state.businessName = data.businessName;
  start(body.id);
});

function start(id) {
  state.id = id;
  state.report = "";
  state.dossier = "";
  form.hidden = true;
  $("progress").hidden = false;
  $("output").hidden = true;
  $("log").innerHTML = "";

  const source = new EventSource(`/api/reports/${id}/events`);
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    switch (event.type) {
      case "phase":
        $("phase").textContent = event.message;
        log(event.message);
        break;
      case "progress":
        log(event.message);
        break;
      case "dossier":
        state.dossier = event.markdown;
        render($("dossier"), state.dossier);
        log("Research complete.");
        break;
      case "report_delta":
        state.report += event.text;
        $("output").hidden = false;
        scheduleRender();
        break;
      case "done":
        state.report = event.report;
        render($("report"), state.report);
        $("phase").textContent = "Report ready";
        $("saved").textContent = event.savedTo ? `Saved on the server to ${event.savedTo}` : "";
        $("output").hidden = false;
        source.close();
        break;
      case "error":
        $("phase").textContent = "Something went wrong";
        log(event.message);
        form.hidden = false;
        source.close();
        break;
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) log("Lost connection to the server.");
  };
}

$("download").addEventListener("click", () => {
  const text = `${state.report}\n\n---\n\n# Appendix: Research dossier\n\n${state.dossier}\n`;
  const blob = new Blob([text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.businessName || "report").replace(/[^a-z0-9]+/gi, "-")}-ai-playbook.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("print").addEventListener("click", () => window.print());

$("toggle-dossier").addEventListener("click", () => {
  const showing = !$("dossier").hidden;
  $("dossier").hidden = showing;
  $("report").hidden = !showing;
  $("toggle-dossier").textContent = showing ? "Show research dossier" : "Show report";
});

$("restart").addEventListener("click", () => {
  $("output").hidden = true;
  $("progress").hidden = true;
  form.hidden = false;
  window.scrollTo(0, 0);
});

loadEmployees();
