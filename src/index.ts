import { buildDigest } from "./digest";
import { postToChat, renderHtml } from "./render";
import type { Digest, Env } from "./types";

/** How long a digest built for the web page is reused before rebuilding. */
const PAGE_CACHE_SECONDS = 1800;

async function cachedDigest(env: Env, origin: string, ctx: ExecutionContext): Promise<Digest> {
  const cache = caches.default;
  const key = new Request(`${origin}/__digest-cache`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as Digest;
  const digest = await buildDigest(env);
  ctx.waitUntil(
    cache.put(key, new Response(JSON.stringify(digest), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${PAGE_CACHE_SECONDS}` },
    })),
  );
  return digest;
}

async function send(env: Env, pageUrl?: string): Promise<{ digest: Digest; sent: boolean }> {
  const digest = await buildDigest(env);
  if (!env.GOOGLE_CHAT_WEBHOOK_URL) return { digest, sent: false };
  await postToChat(env.GOOGLE_CHAT_WEBHOOK_URL, digest, pageUrl);
  return { digest, sent: true };
}

function status(d: Digest) {
  return { generatedAt: new Date(d.generatedAt).toISOString(), claude: d.claude, sources: d.sources };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    const authorised = !env.DIGEST_TOKEN || url.searchParams.get("key") === env.DIGEST_TOKEN;
    if (!authorised) return json({ error: "Add ?key=<your DIGEST_TOKEN> to the address." }, 401);

    try {
      switch (url.pathname) {
        case "/":
          return new Response(renderHtml(await cachedDigest(env, url.origin, ctx)), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        case "/api/digest":
          return json(await cachedDigest(env, url.origin, ctx));
        case "/status":
          return json(status(await cachedDigest(env, url.origin, ctx)));
        case "/send": {
          // Sends to Google Chat right now. Needs DIGEST_TOKEN so strangers cannot trigger it.
          if (!env.DIGEST_TOKEN) return json({ error: "Set the DIGEST_TOKEN secret to use /send." }, 403);
          const { digest, sent } = await send(env, `${url.origin}/?key=${encodeURIComponent(env.DIGEST_TOKEN)}`);
          return json({ sent, note: sent ? "Posted to Google Chat." : "GOOGLE_CHAT_WEBHOOK_URL is not set.", ...status(digest) });
        }
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (e) {
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      send(env).then(({ digest, sent }) =>
        console.log(JSON.stringify({ sent, ...status(digest) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
