import Anthropic from "@anthropic-ai/sdk";
import { REPORT_SYSTEM, RESEARCH_SYSTEM, reportPrompt, researchPrompt } from "./prompts.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// If a request is declined by a safety classifier, the API re-runs it on a
// recommended fallback model instead of returning the refusal.
const BETAS = ["server-side-fallback-2026-07-01"];
const MAX_CONTINUATIONS = 6;

const client = new Anthropic();

function textOf(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function checkStop(message, phase) {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation || "the request was declined";
    throw new Error(`The ${phase} step was declined: ${why}`);
  }
}

function webTools(intake) {
  const search = { type: "web_search_20260209", name: "web_search", max_uses: 25 };
  // Bias search results toward the business's location.
  search.user_location = { type: "approximate", city: intake.city };
  if (intake.state) search.user_location.region = intake.state;
  if (/^[A-Za-z]{2}$/.test(intake.country)) search.user_location.country = intake.country.toUpperCase();
  return [search, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 20 }];
}

// Phase 1: research the business and its competitors with web search/fetch.
async function research(intake, emit) {
  const userMessage = { role: "user", content: researchPrompt(intake) };
  let assistantContent = [];

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const messages = assistantContent.length
      ? [userMessage, { role: "assistant", content: assistantContent }]
      : [userMessage];

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: BETAS,
      fallbacks: "default",
      output_config: { effort: "high" },
      system: RESEARCH_SYSTEM,
      tools: webTools(intake),
      messages,
    });

    stream.on("contentBlock", (block) => {
      if (block.type !== "server_tool_use") return;
      if (block.name === "web_search") emit({ type: "progress", message: `Searching: ${block.input?.query ?? ""}` });
      if (block.name === "web_fetch") emit({ type: "progress", message: `Reading: ${block.input?.url ?? ""}` });
    });

    const message = await stream.finalMessage();
    checkStop(message, "research");
    assistantContent = [...assistantContent, ...message.content];

    // The server-side tool loop pauses after a fixed number of iterations;
    // re-sending the conversation resumes it where it left off.
    if (message.stop_reason !== "pause_turn") break;
    emit({ type: "progress", message: "Continuing research…" });
  }

  const dossier = textOf(assistantContent).trim();
  if (!dossier) throw new Error("Research finished without producing a dossier.");
  return dossier;
}

// Phase 2: turn the dossier into the AI employee playbook.
async function writeReport(intake, dossier, emit) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "high" },
    system: REPORT_SYSTEM,
    messages: [{ role: "user", content: reportPrompt(intake, dossier) }],
  });

  stream.on("text", (delta) => emit({ type: "report_delta", text: delta }));

  const message = await stream.finalMessage();
  checkStop(message, "report");
  const report = textOf(message.content).trim();
  if (message.stop_reason === "max_tokens") {
    emit({ type: "progress", message: "The report hit the length limit and may end abruptly." });
  }
  return report;
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message ?? "")) return "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key does not have access to the requested model or feature.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "unknown"}): ${err.message}`;
  return err?.message || String(err);
}

export async function runPipeline(intake, emit) {
  emit({ type: "phase", phase: "research", message: `Researching ${intake.businessName} and its competitors…` });
  const dossier = await research(intake, emit);
  emit({ type: "dossier", markdown: dossier });

  emit({ type: "phase", phase: "report", message: "Writing the AI employee playbook…" });
  const report = await writeReport(intake, dossier, emit);
  return { dossier, report };
}
