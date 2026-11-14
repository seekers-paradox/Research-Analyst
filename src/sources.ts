import type { Source } from "./types";

/**
 * Feeds the digest reads. Add, remove or re-categorise freely: a feed that
 * fails is skipped and shown as failing on /status, it never breaks the digest.
 */
export const SOURCES: Source[] = [
  // Official lab announcements
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", category: "releases", weight: 3 },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", category: "releases", weight: 3 },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/", category: "releases", weight: 3 },
  { name: "Anthropic (via Google News)", url: gnews("site:anthropic.com"), category: "releases", weight: 3 },
  { name: "xAI (via Google News)", url: gnews("site:x.ai"), category: "releases", weight: 3 },
  { name: "Meta AI (via Google News)", url: gnews("site:ai.meta.com"), category: "releases", weight: 3 },
  { name: "Mistral (via Google News)", url: gnews("site:mistral.ai"), category: "releases", weight: 2 },

  // Research and benchmarks
  { name: "Hugging Face blog", url: "https://huggingface.co/blog/feed.xml", category: "research", weight: 2 },
  { name: "Import AI", url: "https://importai.substack.com/feed", category: "research", weight: 2 },
  { name: "Interconnects", url: "https://www.interconnects.ai/feed", category: "research", weight: 2 },
  { name: "AI benchmarks (Google News)", url: gnews('"AI" (benchmark OR eval) (LLM OR model)'), category: "research", weight: 1 },

  // Tools and techniques (practitioner analysis)
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "tools", weight: 2 },
  { name: "Latent Space", url: "https://www.latent.space/feed", category: "tools", weight: 2 },
  { name: "Hacker News (AI, 150+ points)", url: "https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude+OR+OpenAI+OR+Anthropic+OR+Gemini&points=150", category: "tools", weight: 2 },

  // Jobs and market
  { name: "Lenny's Newsletter", url: "https://www.lennysnewsletter.com/feed", category: "jobs", weight: 2 },
  { name: "Indeed Hiring Lab", url: "https://www.hiringlab.org/feed/", category: "jobs", weight: 2 },
  { name: "AI jobs (Google News)", url: gnews('"AI" (jobs OR hiring OR layoffs) (demand OR market OR report)'), category: "jobs", weight: 1 },

  // Industry news
  { name: "Techmeme", url: "https://www.techmeme.com/feed.xml", category: "industry", weight: 2 },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", category: "industry", weight: 1 },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", category: "industry", weight: 1 },
  { name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed", category: "industry", weight: 1 },
];

function gnews(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query + " when:7d")}&hl=en-US&gl=US&ceid=US:en`;
}
