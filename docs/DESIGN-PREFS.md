# Scott's design language — a living, multi-project standard

How the owner (Scott) likes apps designed and built. **This is a LIVING doc**:
it grows every time he makes a design decision, in any project that carries it.

## How this doc works (the protocol — travels with the file)
- **The master copy lives in the `leopard-safety-watch` repo.** Other projects
  carry a copy at `docs/DESIGN-PREFS.md`, referenced from their `CLAUDE.md`.
- **Any session, any project:** when Scott expresses a NEW preference, approves
  a pattern, or rejects one — update this file in the same PR (rule + a dated
  line in the Decision log at the bottom). If you're NOT in the master repo,
  tell him at the end of your summary to sync the change back to the master.
- **Keep every rule project-agnostic** — no app names, file paths or
  domain-specific nouns in the rules themselves (the Decision log may name the
  project that taught us the lesson).
- Periodically he'll say "re-sync design prefs" — replace the local copy with
  the master (or merge local additions back).

## Design philosophy
- **Consistency IS the feature.** Build a small set of shared house systems
  (dialogs, toasts, loading states, notifications, pickers, colours) and make
  every surface use them. Never hand-roll a local variant of something that
  exists. A second app in the same family replicates the first's UI
  infrastructure — menu shape, settings shape, notification bell — not just
  its look.
- **One page per job.** If two tabs/views show substantially the same
  information, merge them — don't make users learn a distinction that isn't
  real. Keep reference material (orders/catalogs/libraries) separate from
  operational surfaces (today's actions).
- **Ship polished increments, fast.** Small complete verified changes, merged
  quickly, each announced to users in one consolidated "what's new" line
  written for them (net resulting state, never engineering blow-by-blow).
- **Defer explicitly.** When a feature idea is "TBC", build NOTHING for it —
  no placeholder buttons, no half-UI. Record it as deferred and add it the day
  it's specified.

## Decision patterns (how he structures workflows — reuse these shapes)
- **Count first, verify after.** A self-reported action (booking, marking)
  takes effect IMMEDIATELY for accounting; the approval chain behind it is a
  verification layer that never blocks the headline number or downstream
  automation. Anomalies are FLAGGED (with a stated reason), not rejected.
- **Rights vest on confirmation.** Holding an appointment on paper grants
  nothing; the person must actively confirm/take over before the system vests
  their rights for the day. Reassignment resets that state — rights never
  carry over silently.
- **Two-sided handover.** Responsibility transfers have an outgoing side
  (notes, follow-ups) and an incoming side (review + confirm); the outgoing
  side never blocks the incoming one.
- **Juniors acknowledge; leaders take over.** The lowest tier of a duty/task
  doesn't hold rights or handovers — they ACKNOWLEDGE so the plan knows they
  know. Reserve/standby roles are visible but inert until activated.
- **Multi-step authority.** Planning flows split by echelon: the higher HQ
  allocates (who covers), the lower unit fills (which people). Don't collapse
  these into one super-user action.
- **Delegation is explicit.** Leaders can name delegates who gain a scoped
  slice of their rights; delegation is granted per-scope by the responsible
  leader, revocable, and visible in a management view.
- **Exception-based accounting.** Absence of a record means "not yet
  accounted", never a silent default. Aggregates that might be partial must
  say so rather than read as zero.
- **Permission-gated visibility, not obscurity.** "As long as they have
  permission to it they should see it" — navigation/entries appear for anyone
  entitled, hidden for anyone not. Don't hide features behind unlinked URLs.
- **Show fairness data at decision points.** When picking people for tasking,
  surface load history inline (times in the last 90 days, last date) right in
  the picker — don't make the planner look it up.
- **Live settings beat constants.** Anything the owner might tune (defaults,
  thresholds, catalogs) lives in the database, editable in-app; code holds
  only the fallback. Never "fix" a live value by editing code.
- **Declare responsibility where it is exercised.** Who approves, verifies or
  supervises a process is defined on that process — bound to a position type
  (permanent) or, as a temporary exception, to a person with an expiry — and
  merely *displayed* on people's profiles. Never tag a process role onto a
  person by hand; profiles derive, processes decide.
- **Setup lives in its own surface; the end-user app stays clean.** When a
  product has both people who RUN a process and people who SET IT UP, give the
  setup its own admin surface (same chassis and themes, an "Admin mode" header,
  three task-named tabs or fewer) reached from the end-user app's ⋮ menu by
  those with rights — never bury configuration behind a conditional tab in the
  end-user app. Tabs are named for the task (Roster · Duties · Oversight), not
  the data structure (Boards · Types · Pools); merge a lookup that only serves
  one thing into that thing (a duty's eligible pool sits with the duty).
- **Wider sight is never higher rank.** Any mechanism that widens what a
  person can see (a staff role, a second hat, a visibility grant) widens READ
  reach only; owner-grade powers derive solely from the position's own unit.
  Authority tier is computed before restrictions are applied — a restriction
  withholds, it never demotes.
- **Deny beats everything, and says why.** A restriction on an individual is
  applied last and overrides any default, exception or process role; it always
  carries a reason and may carry an expiry that lifts it automatically. The
  top owner can never be restricted from inside the app.
- **Defaults follow the position; deviations attach to the person.** A
  position (seat/appointment) carries sensible defaults derived from WHERE it
  sits — its scope is its own unit by default, its rights come from its
  appointment type — so creating one needs no manual tagging. Anything a unit
  wants that differs from the default is granted to the individual holding it,
  not by hand-editing the position; the position stays the reusable template.
  Defaults are always overridable, never locked.

## Navigation & layout
- **Bottom tabs = primary navigation** (mobile-first). Never hidden.
- **⋮ kebab = secondary/overflow** — cross-navigation goes DIRECTLY in the
  kebab (permission-gated), never buried inside a Settings page. Standard
  order: cross-navigation entries → Settings → install/tutorial entries →
  Send app feedback → Sign out.
- **Apps link to apps; consoles stay inside their app.** A sibling APP gets
  exactly ONE kebab entry — its main surface. That app's own consoles are
  reached from within it (where they ARE listed directly, permission-gated),
  not flattened into every sibling's menu — otherwise the menu misrepresents
  consoles as separate apps.
- **Settings pages share one shape across apps**: Account → Appearance →
  This device (sign out) → About, plus app-specific cards. Display options are
  per-app (installed PWAs have separate storage; that's expected).
- **Collapsible sections beat dropdowns.** Show ALL parallel groups at once as
  collapsible cards with informative headers (name + fill/summary counts);
  auto-open what needs attention, auto-collapse what's complete; an active
  interaction pins its card open. Never hide parallel data behind a single
  `<select>`.
- **Group people by the organisation tree** (company → platoon → section):
  headers with counts, subgroup subheaders, the person's own subunit as a row
  suffix.
- **Standards up front, customs grouped.** In type/catalog rows: the default/
  organisation-wide items first as chips; user-created items folded under an
  "Others" chip organised by owning group.
- Every app in the family gets an in-app **feedback entry in the kebab**
  routing to the same central inbox, with the app tagged as its surface.

## Feel & responsiveness
- **Optimistic UI for marking/toggling:** paint the change instantly, write in
  the background, roll back with an error toast on failure, reconcile with ONE
  debounced quiet re-fetch (~1.2s after the last action). Never blank a view
  and refetch everything per tap.
- **Pull-to-refresh (touch), tuned — replicate exactly:** THRESH 95px ·
  DEADZONE 22px · MAXPULL 150px · DWELL 200ms (must HOLD past the line to arm
  — a fast flick never triggers) · 0.5× finger resistance capped at 72px ·
  min 450ms spinner. Only from scrollTop 0; direction-locked (dy > |dx|×1.5);
  passive listeners; small floating disc indicator (↓ → ↻ when armed → ring
  spinner), never a stretchy header. Refresh = refetch the current view AND a
  build-version check (ETag/Last-Modified HEAD) that reloads if a new deploy
  is live.
- **Desktop/no-touch:** version-check on focus/visibility (30s throttle) +
  every 5 min; never silently reload (unsaved input) — show a "New version
  available — tap to update" pill toast, once per session.
- **Network resilience:** fetch wrappers never reject; a failed load paints a
  themed "Couldn't load — Retry" state IN PLACE (never a blank page, never a
  dead-end, never cache an error as data). A network blip must NEVER sign the
  user out. Automatic offline bar on connectivity loss.
- **Loading = skeleton shimmer** reserving layout; never "Loading…" text alone
  or a bare spinner. Prefetch/warm likely-next tabs.
- **Focus refresh:** returning to the app (focus/visibility) re-renders the
  current tab — throttled (~90s) and NEVER while an input/textarea/select is
  focused (mid-typed forms are sacred). Read-mostly tabs only; an open tab
  must never show yesterday's data.
- **Removed/renamed routes fall back gracefully** — an old hash/link lands on
  the nearest surviving view, never a 404 or blank.
- Any decorative animation is stilled under `prefers-reduced-motion: reduce`.

## Dialogs, copy & safety
- Themed non-blocking dialog/toast system; **never** native
  `alert()`/`confirm()`. Destructive confirms use a danger style, focus
  Cancel, and put the consequence in the button verb.
- **Copy is written for the end user**, plain language, states the physical
  consequence ("Only confirm what you've physically checked"). Instructional
  sub-lines under actions, not tooltips.
- Confirmation prompts before irreversible or outward-facing actions
  (broadcasts, mass updates) — and mass actions state their count.
- Honest empty/all-clear states ("✓ Nothing awaiting…") instead of hiding a
  section.

## Branding & naming
- **Family naming pattern:** sibling apps share a name family that "rolls off
  the tongue" (e.g. "… Safety Watch" / "… Duty Watch"). Test names out loud;
  he rejects clunky ones even after shipping.
- **Logos are dignified, not cartoonish** — he rejected a "kindergarten" mark.
  He often supplies final artwork; keep the FULL-RESOLUTION master committed in
  the repo (e.g. `icons/<app>-source.png`) so it can be re-rendered on demand.
- Each installed app has its own icon/manifest identity; keep an app's icon
  stable once users have installed it.
- A dark, branded appbar can persist across light/dark themes as the brand.

## PWA & multi-app family
- Installable PWAs: manifest + icons per app, safe-area insets, pre-paint theme
  script (no flash), meta theme-color follows theme, icon badging for unread.
- **Theme OPTIONS are identical across the app family — same names, same
  palettes** (e.g. Automatic / Light / Dark / brand theme). What's per-app is
  the CHOICE (own storage key), never the menu of options. A brand default
  (e.g. black & gold) is fine.
- Same account/sign-in across the family (same domain → passkeys carry over);
  each installed app carries its OWN sign-in screen (isolated storage), with
  passkey offered whenever the device supports it (not gated on a local flag a
  fresh container won't have).
- Per-app "what's new" feeds from one shared changelog (entries tagged by
  app); opening the feed marks it read; net-state coalescing by topic.
- Guided tours per surface: overview teaches UI mechanics first, walks every
  tab last, stays short; deep walkthroughs live in per-tab tutorials; a
  materially changed step is re-shown to returning users.

## Engineering defaults (non-negotiable)
- **Server-side authorisation always** — resolve the caller and scope-check on
  the server; filter both the unit AND the target person to the caller's
  subtree. Never trust a client-supplied id. The client is UX, not security.
- **Data minimisation:** no more personal data than the feature needs;
  anonymous flows stay truthfully anonymous in their copy.
- Reads degrade instead of 500ing; state-changing decisions use
  compare-and-set so racing approvers can't double-fire side effects;
  migrations are idempotent, auto-applied, and guard updates on the stale
  value so they never revert live edits.
- Escape user data for BOTH text and attribute positions; never inline user
  data into inline-JS handlers.
- Verify before shipping: syntax-check everything, drive the real flow in a
  real browser, ship regression tests with the fix.

## The House Kit — tuned modules worth copying, not rewriting
The reference implementations live in the master repo under `public/shared/`
(classic scripts; most expect the page to provide `api`/`post`/`route`/`code`
globals and the CSS design tokens `--surface/--text/--muted/--accent/--border/
--err/--ok`). When another project needs one, COPY the file and adapt the
globals — the tuning is the value:

| Module | What it gives | Portability notes |
|---|---|---|
| `app-refresh.js` | The tuned pull-to-refresh + build-version check + desktop update toast (constants above) | needs `route()`, `code()` |
| `dialog.js` | `lswConfirm(msg,{title,ok,cancel,danger})` / `lswToast(msg,{type,dur})` + the automatic offline bar | standalone + tokens |
| `core.js` | `esc()` (text+attribute-safe), `api`/`post` never-reject wrappers, `lswSkeleton`, `lswLoadError` retry card, prefetch/warmTabs, feedback photo-attach (downscale+compress to a bounded data URL) | the family's spine |
| `daterange.js` | Preset-chip date range + single date field w/ Today/Now, no-future guard | standalone + tokens |
| `scope.js` | Cascading org-tree drill chips (echelon-scoped server-side) | needs org endpoint |
| `tour.js` | Guided-tour engine (per-surface catalogs, progress-persisted, menu-aware) | needs catalog + progress endpoint |
| `splash.js` | Branded splash + cross-surface "hop" transition naming the destination | tokens |
| `webauthn.js` | Passkey enrol/login incl. conditional mediation | needs auth endpoints |
| `notifications.js` + `changelog.js` | Crest-bell feed + per-app net-state "what's new" with read watermarks | most coupled — copy last |

Patterns small enough to re-type from this doc rather than copy: optimistic
marking (above), collapsible section cards, the per-app theme scaffold
(pre-paint script + `data-theme` overrides + own storage key).

## Decision log (append-only, dated — newest first)
- **16 Sep 2026 (leopard-safety-watch):** the duty programme was split the way
  the safety app is: a lean end-user watch (Home · Orders · Strength) and a
  separate Duty admin console (Roster · Duties · Oversight, Planners in ⋮).
  The CO rejected data-structure tab names (Boards/Watch/Pools/Duties/
  Delegates) for task names, merged a duty's pool into the duty, and made
  "who may plan / define" a WORKFLOW — responsibilities bound to appointment
  types in the same permissions engine as everything else, with the old
  hard-coded seat list kept only as an additive fallback. Terms of reference
  added per duty; no battalion-level standing-orders document for now.
- **16 Sep 2026 (leopard-safety-watch):** post-build audit of the authority
  model fixed one class: anything that widens what a person can SEE (a staff
  overlay, an extra hat, Bn staff visibility) must never promote them — owner-
  grade power comes only from the position's own unit. Also: a restriction
  withholds rights but never demotes (authority tier is computed from the
  unrestricted set, so a junior can't restrict a senior into reach); a
  retired position type already held stays selectable (never silently
  re-type a seat on save); an editor converting a custom seat to a typed one
  drops what the type now owns instead of erroring after the fact.
- **15 Sep 2026 (leopard-safety-watch):** the authority model was settled in
  one sitting and built the same day — three authority levels only (run your
  unit / own the app for your unit / deputy), a position catalog per echelon
  with rights derived live from the position type, scope always automatic from
  the position's unit, responsibilities declared on the process that exercises
  them (bound to a position type or, temporarily, a person) and shown
  read-only on profiles, per-person restrictions applied last (deny beats
  every source, with reason + expiry), read reach as a rule not a grant, and
  views opening on the unit you command. Retired an overlapping role rather
  than explaining it. Legacy grants kept working throughout the change-over.
- **15 Sep 2026 (leopard-safety-watch):** a new position's scope defaults to
  its OWN unit (the company it sits in) — the editor must never open with no
  scope ticked; cross-unit scope stays a deliberate override. Direction set
  for the follow-on: appointment types per echelon as a pick-list carrying
  default rights, with per-unit deviations granted to the person, not the
  seat (rule "Defaults follow the position; deviations attach to the person").
- **19 Jul 2026 (leopard-safety-watch):** a sibling app's kebab links only to
  the other app's MAIN surface, never to its internal consoles ("realistically
  they are all the app") — consoles are one hop away, inside their own app.
- **19 Jul 2026 (leopard-safety-watch):** theme options must be IDENTICAL
  across sibling apps (same four options, same palettes); only the selection
  is per-app. Sibling app aligned to the family's Light/Dark/Leopard palettes,
  brand-dark appbar kept across all themes.
- **19 Jul 2026 (leopard-safety-watch):** doc rebuilt as the living
  multi-project standard; added Decision patterns (count-first/vesting/
  handover/acknowledge/multi-step authority/delegation), Branding & naming,
  the House Kit table, and this protocol+log. Prior single-page version
  captured navigation/feel/PWA/engineering sections (17–19 Jul decisions:
  kebab-menu parity, per-app appearance, optimistic strength marking,
  org-tree grouping, Home/Duty merge, "Others" grouping, duty feedback
  surface, pull-to-refresh tuning).
