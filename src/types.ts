export type Category = "releases" | "research" | "tools" | "jobs" | "industry";

export const CATEGORY_ORDER: Category[] = ["releases", "research", "tools", "jobs", "industry"];

export const CATEGORY_LABELS: Record<Category, string> = {
  releases: "Model & product releases",
  research: "Research & benchmarks",
  tools: "Tools & techniques",
  jobs: "Jobs & market",
  industry: "Industry news",
};

export interface Source {
  name: string;
  url: string;
  category: Category;
  /** Higher = more trusted/important when ranking without Claude. */
  weight: number;
}

export interface Item {
  id: string;
  title: string;
  url: string;
  source: string;
  category: Category;
  weight: number;
  /** Epoch milliseconds. */
  published: number;
  snippet: string;
  /** One-line "why it matters", written by Claude when available. */
  why?: string;
}

export interface SourceStatus {
  name: string;
  ok: boolean;
  items: number;
  error?: string;
}

export interface ClaudeStatus {
  /** "ok" = summaries written by Claude; "off" = no API key; "failed" = call failed. */
  state: "ok" | "off" | "failed";
  model?: string;
  detail?: string;
}

export interface Digest {
  generatedAt: number;
  windowHours: number;
  topLine: string;
  sections: { category: Category; items: Item[] }[];
  sources: SourceStatus[];
  claude: ClaudeStatus;
}

export interface Env {
  ANTHROPIC_API_KEY?: string;
  GOOGLE_CHAT_WEBHOOK_URL?: string;
  DIGEST_TOKEN?: string;
  CLAUDE_MODEL?: string;
  MAX_PER_CATEGORY?: string;
}
