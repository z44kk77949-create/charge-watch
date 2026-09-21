// One-time admin endpoint: point the Telegram bot's webhook at this deployment.
//   GET /api/telegram/init?key=<ADMIN_INIT_KEY>
//
// It also registers TELEGRAM_WEBHOOK_SECRET when one is set, which is what makes
// the webhook trustworthy — without it, anyone who guesses the URL can POST
// forged "pairing" updates.
import { timingSafeEqual } from "../_util.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!env.ADMIN_INIT_KEY || !timingSafeEqual(key, env.ADMIN_INIT_KEY)) return new Response("forbidden", { status: 403 });
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not set." }, { status: 503 });

  const base = env.APP_BASE_URL || new URL(request.url).origin;
  const body = { url: `${base}/api/telegram/webhook`, allowed_updates: ["message"] };
  if (env.TELEGRAM_WEBHOOK_SECRET) body.secret_token = env.TELEGRAM_WEBHOOK_SECRET;

  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  return Response.json({ ...out, webhook: body.url, secret_registered: !!env.TELEGRAM_WEBHOOK_SECRET });
}
