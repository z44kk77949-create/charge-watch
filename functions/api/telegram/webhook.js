// Telegram webhook — pairing, and a couple of commands worth having at 2am in a
// field with one bar of signal.
//
// SECURITY: the first thing this does is authenticate the caller as Telegram.
// When the webhook is registered with a secret token (see telegram/init.js),
// Telegram sends it in this header on every update; a forged POST to this URL
// won't have it. The check is enforced only once TELEGRAM_WEBHOOK_SECRET is set,
// so an existing deployment keeps working until the owner registers one — and
// `/api/health` reports whether it has been.
//
// Pairing takes a SIGNED token, never a bare customer id: the deep link is
// pasted into a chat app, and anyone who saw an unsigned one could point their
// own Telegram at a stranger's charger.

import { db, all, first, run, now, verifyPairToken, STATUS_LABEL, timingSafeEqual } from "../_util.js";
import { tgSend } from "../_notify.js";

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  const want = env.TELEGRAM_WEBHOOK_SECRET;
  if (want && !timingSafeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", want)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!db(env)) return new Response("ok");

  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.text) return new Response("ok");
  const chatId = String(msg.chat.id);
  const text = String(msg.text).trim();

  let reply;
  const start = text.match(/^\/start(?:\s+(\S+))?/);

  if (start && start[1]) {
    const customerId = await verifyPairToken(env, start[1]);
    if (!customerId) {
      reply = "That link isn’t valid any more. Open Charge Watch and tap Connect Telegram again.";
    } else {
      const c = await first(env, "select id, display_name from customers where id = ?", [customerId]);
      if (!c) {
        reply = "That link doesn’t match an account. Open Charge Watch and tap Connect Telegram again.";
      } else {
        // One chat, one account: if this chat was paired to someone else (a
        // shared phone, a re-scan of an old link), the newest pairing wins and
        // the old one is cleared, or both accounts would notify the same chat.
        await run(env, "update customers set telegram_chat_id = null where telegram_chat_id = ? and id != ?", [chatId, customerId]);
        const res = await run(env, "update customers set telegram_chat_id = ?, notify_telegram = 1 where id = ?", [chatId, customerId]);
        reply = res.ok
          ? `Connected${c.display_name ? `, ${c.display_name}` : ""}. I’ll message you here the moment your charger is ready.\n\nSend /status any time to check on it, or /stop to turn these messages off.`
          : "Something went wrong connecting this chat — try the link again.";
      }
    }
  } else if (/^\/status\b/i.test(text)) {
    reply = await statusFor(env, chatId);
  } else if (/^\/stop\b/i.test(text)) {
    const res = await run(env, "update customers set notify_telegram = 0 where telegram_chat_id = ?", [chatId]);
    reply = res.ok
      ? "Turned off. You won’t get charger messages here — the app still shows the status, and /start from the app’s link turns this back on."
      : "Couldn’t change that just now — try again.";
  } else {
    reply = "Charge Watch. Connect this chat from the app (Me → Connect Telegram) and I’ll tell you when your charger is ready.\n\n/status — how my chargers are doing\n/stop — stop these messages";
  }

  await tgSend(env, chatId, reply);
  return new Response("ok");
}

async function statusFor(env, chatId) {
  const c = await first(env, "select id from customers where telegram_chat_id = ?", [chatId]);
  if (!c) return "This chat isn’t connected to an account yet. Open Charge Watch and tap Connect Telegram.";
  const rows = await all(env,
    `select t.ref, t.label, t.status, t.slot, n.name as tent_name
       from tickets t join tents n on n.id = t.tent_id
      where t.customer_id = ? and t.status != 'collected'
      order by t.received_at asc`, [c.id]);
  if (!rows.length) return "Nothing of yours is in a tent right now.";
  return "Your chargers:\n\n" + rows.map(r =>
    `• ${r.label ? `Tag ${r.label}` : r.ref} — ${STATUS_LABEL[r.status] || r.status} at ${r.tent_name}${r.slot ? ` (slot ${r.slot})` : ""}`
  ).join("\n") + "\n\nOpen the app to show your collection code at the counter.";
}

export { now };
