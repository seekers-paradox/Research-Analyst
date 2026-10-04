import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AI_EMPLOYEES, validateIntake } from "./src/intake.js";
import { describeError, runPipeline } from "./src/pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(here, "reports");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));
app.get("/vendor/marked.umd.js", (_req, res) => res.sendFile(path.join(here, "node_modules/marked/lib/marked.umd.js")));
app.get("/vendor/purify.min.js", (_req, res) => res.sendFile(path.join(here, "node_modules/dompurify/dist/purify.min.js")));

// In-memory job store. Each job keeps its full event log so a browser that
// connects (or reconnects) late still sees everything.
const jobs = new Map();

function createJob(intake) {
  const job = { id: randomUUID(), intake, status: "running", events: [], listeners: new Set(), report: "", dossier: "" };
  job.emit = (event) => {
    job.events.push(event);
    for (const send of job.listeners) send(event);
  };
  jobs.set(job.id, job);
  return job;
}

async function saveReport(job) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const slug = job.intake.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const file = path.join(REPORTS_DIR, `${slug || "report"}-${job.id.slice(0, 8)}.md`);
  await writeFile(file, `${job.report}\n\n---\n\n# Appendix: Research dossier\n\n${job.dossier}\n`);
  return file;
}

async function run(job) {
  try {
    const { dossier, report } = await runPipeline(job.intake, job.emit);
    job.dossier = dossier;
    job.report = report;
    job.status = "done";
    const file = await saveReport(job).catch((err) => {
      console.error("Could not save report:", err);
      return null;
    });
    job.emit({ type: "done", report, savedTo: file ? path.relative(here, file) : null });
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    job.status = "error";
    job.emit({ type: "error", message: describeError(err) });
  }
}

app.get("/api/ai-employees", (_req, res) => res.json(AI_EMPLOYEES));

app.post("/api/reports", (req, res) => {
  const { intake, errors } = validateIntake(req.body);
  if (errors) return res.status(400).json({ errors });
  const job = createJob(intake);
  run(job);
  res.status(202).json({ id: job.id });
});

app.get("/api/reports/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Report not found" });
  res.json({ id: job.id, status: job.status, intake: job.intake, report: job.report, dossier: job.dossier });
});

// Server-sent events stream of a job's progress.
app.get("/api/reports/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of job.events) send(event);
  if (job.status !== "running") return res.end();

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const listener = (event) => {
    send(event);
    if (event.type === "done" || event.type === "error") res.end();
  };
  job.listeners.add(listener);
  req.on("close", () => {
    clearInterval(keepAlive);
    job.listeners.delete(listener);
  });
});

app.listen(PORT, () => {
  console.log(`Research Analyst running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
});
