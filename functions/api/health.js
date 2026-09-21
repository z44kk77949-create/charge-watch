// Liveness + configuration check. Deliberately says whether each optional piece
// is configured, and NEVER what it is configured to — "telegram: true" is safe
// to expose; a token is not.
import { db, json, first } from "./_util.js";

export async function onRequestGet(ctx) {
  const { env } = ctx;
  const bound = !!db(env);
  let reachable = false, tickets = null;
  if (bound) {
    const r = await first(env, "select count(*) as n from tickets");
    reachable = !!r;
    tickets = r ? Number(r.n) : null;
  }
  return json({
    ok: bound && reachable,
    database: { bound, reachable, tickets },
    telegram: !!env.TELEGRAM_BOT_TOKEN,
    telegram_webhook_secret: !!env.TELEGRAM_WEBHOOK_SECRET,
    push: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    pair_signing: !!(env.PAIR_SECRET || env.ADMIN_INIT_KEY),
  });
}
