// Who is calling, and what does their surface need to boot?
//
// Every surface calls this first. It answers for both kinds of user and, when
// nobody is signed in, still returns the handful of public facts a sign-in
// screen needs (the event name for the header, whether the app has been set up
// at all, and the VAPID key a browser needs before it can even offer push).

import { db, noDb, json, first, all, subjectByToken, getSettings, pairToken } from "./_util.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();

  const cred = new URL(request.url).searchParams.get("code");
  const [settings, s] = await Promise.all([getSettings(env), subjectByToken(env, cred)]);

  const pub = {
    event_name: settings.event_name,
    vapid_public: env.VAPID_PUBLIC_KEY || null,
    telegram_bot: env.TELEGRAM_BOT_USERNAME || null,
  };

  if (!s) {
    // `needs_setup` drives the admin console's first-run form. It is a bare
    // boolean — it says the staff table is empty, never who is in it.
    const n = await first(env, "select count(*) as n from staff");
    return json({ ok: false, kind: null, needs_setup: !n || Number(n.n) === 0, ...pub });
  }

  if (s.type === "customer") {
    const c = s.row;
    return json({
      ok: true, kind: "customer", id: c.id,
      display_name: c.display_name || null,
      notify_telegram: !!c.notify_telegram,
      notify_push: !!c.notify_push,
      telegram_linked: !!c.telegram_chat_id,
      // Only built when a bot is configured AND a signing secret exists — an
      // unsigned pairing link would let anyone who saw it hijack notifications.
      pair_token: env.TELEGRAM_BOT_USERNAME ? await pairToken(env, c.id) : null,
      ...pub,
    });
  }

  const staff = s.row;
  const tents = await all(env, "select id, name, code, location, slots, active from tents order by code");
  const mine = staff.tent_id ? tents.find(t => t.id === staff.tent_id) || null : null;
  const admin = staff.role === "admin" || staff.role === "owner";
  return json({
    ok: true, kind: "staff", id: staff.id, name: staff.name, username: staff.username,
    role: staff.role, is_admin: admin,
    tent: mine,
    // A handler is offered only their own tent; an admin may work any of them.
    tents: admin ? tents.filter(t => t.active) : (mine && mine.active ? [mine] : []),
    settings: {
      collect_requires_code: settings.collect_requires_code,
      auto_charging_on_intake: settings.auto_charging_on_intake,
    },
    ...pub,
  });
}
