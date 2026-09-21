// Outbound notification fan-out: Telegram first, Web Push alongside it.
//
// Both channels are DORMANT until their environment variables are set
// (TELEGRAM_BOT_TOKEN / VAPID_*). An unconfigured deployment therefore sends
// nothing and reports `sent: 0` — it never throws, and never blocks the state
// change that triggered it. Marking a charger ready must succeed even if
// Telegram is down; the customer can still see the status in the app.

import { all, run, now, sha256hex } from "./_util.js";
import { sendWebPush } from "./_webpush.js";

export async function tgSend(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { return false; }
}

// Push to every device a subject has registered. A 404/410 from the push
// service means that subscription is dead (app uninstalled, browser data
// cleared) — prune it, or the row lingers forever and every later send burns a
// request on it.
async function pushAll(env, subjectType, subjectId, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const subs = await all(env, "select endpoint, p256dh, auth from push_subscriptions where subject_type = ? and subject_id = ?", [subjectType, subjectId]);
  let sent = 0;
  for (const s of subs) {
    let res;
    try { res = await sendWebPush(env, s, payload); } catch (e) { res = { ok: false, status: 0 }; }
    if (res.ok) sent++;
    else if (res.status === 404 || res.status === 410) {
      await run(env, "delete from push_subscriptions where endpoint = ?", [s.endpoint]);
    }
  }
  return sent;
}

// Tell a customer something about their charger. Returns how many channels
// actually delivered, so the caller can record "notified" honestly rather than
// claiming a message that never left the building.
export async function notifyCustomer(env, customer, { title, body, url }) {
  if (!customer) return 0;
  let sent = 0;
  if (customer.notify_telegram && customer.telegram_chat_id) {
    if (await tgSend(env, customer.telegram_chat_id, `${title}\n\n${body}`)) sent++;
  }
  if (customer.notify_push) {
    sent += await pushAll(env, "customer", customer.id, { title, body, url: url || "/", tag: "charge-watch" });
  }
  return sent;
}

// The one place the "your charger is ready" wording is composed, so the Telegram
// message, the push notification and the reminder all say the same thing and
// the owner-editable `ready_message` setting reaches every channel.
export function readyText(settings, ticket, tent) {
  const where = tent ? `${tent.name}${tent.location ? ` — ${tent.location}` : ""}` : "the charging tent";
  const which = ticket.label ? `Charger ${ticket.label}` : `Ticket ${ticket.ref}`;
  return {
    title: `${which} is ready`,
    body: `${settings.ready_message}\n\nCollect at: ${where}\nShow your collection code at the counter.`,
  };
}

// A short, stable de-duplication key so the same event can't notify twice if a
// handler double-taps "Mark ready" (the button guard covers the UI; this covers
// the network retry behind it).
export async function eventKey(ticketId, event) {
  return (await sha256hex(`${ticketId}:${event}`)).slice(0, 16);
}

export { now };
