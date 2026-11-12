# 09 - Notification producers: backup, services, HA alerts

Status: design (T7.w.11 in the vault plan). Builds on the notification store and
its delivery ([`08-learning-fast-path.md`](08-learning-fast-path.md#t7w5-notification-store),
[`02-core-protocol.md`](02-core-protocol.md#notifications)). Examples use generic
names; nothing here or in the implementation may hold hosts, addresses or tokens.

## Problem

`NotificationStore` ([`notifications.ts`](../core/src/notifications.ts)) and
`NotificationCenter` (`raise` / `resolve`, [`session.ts`](../core/src/session.ts))
are wired in [`index.ts`](../core/src/index.ts) but have no producer. Three
conditions should reach the user without asking: a failed or missing backup, a
service the Core depends on going down, and Home Assistant's own alerts.

## Current state (what the design relies on)

- **Store.** `raise({source, key, urgency, title, body, renotify})` replaces a keyed
  item in place; `renotify: true` makes it unread again; `resolve(source, key)`
  removes it. `NotificationCenter.raise` speaks an urgent item once, on the most
  recent speech-enabled socket, only when it is new or re-raised with `renotify`;
  with no such socket it is never spoken (`speaker()` returns nothing).
- **Services.** `HealthMonitor` ([`health.ts`](../core/src/health.ts)) polls every
  `services.yaml` entry every 30 s (timeout 3 s, `CORE_HEALTH_*`); `subscribe()`
  fires only when a status or detail **changes**, `snapshot()` gives the latest
  round. Statuses: `ok` (whisper `idle` = ok), `loading`, `down` (+ detail code),
  `disabled`. Visible in `GET /health` and the `services` frame. No hysteresis.
- **HA / "MCP gateway".** The Core reaches HA only over MCP SSE
  (`${HA_URL}/mcp_server/sse`, `HA_CORE_TOKEN`); the gateway
  ([`mcp-gateway.ts`](../core/src/mcp-gateway.ts)) is in-process and its remote
  connection ([`mcp-direct.ts`](../core/src/mcp-direct.ts)) reconnects lazily on the
  next call. So "the gateway is down" means "the HA MCP endpoint is unreachable",
  which the health check already measures (SSE headers + token, no tool call).
  There is no HA REST or WebSocket client; the `ws` package is already a dependency.
- **Backup.** [`deploy/backup/backup-data.ps1`](../deploy/backup/backup-data.ps1) runs
  as a daily scheduled task (03:30, 2 h limit,
  [`install-backup-task.ps1`](../deploy/backup/install-backup-task.ps1)) outside the
  Core. Its only trace is `backup.log` under `%LOCALAPPDATA%`; setup errors before
  the `try` (settings, rclone, tar, missing data dir) are not even logged there.
  The Core cannot see a backup today.

## Decisions

### Common rules

- One producer module per source (`source`: `backup`, `service`, `ha`), each a
  small class taking `NotificationCenter` (or a `raise`/`resolve` port), a clock
  and its input; started in `index.ts`, closed in the shutdown chain.
- Every recurring condition is **keyed**; recovery **resolves** the item silently
  (no "düzeldi" item: a recovered outage is not actionable, and a re-raise with
  new text would bump `raised` and keep a stale item).
- Producer state (timers, flap counters) is in memory. After a Core restart an
  open condition may be raised once more, also when the user had deleted it;
  accepted (see open question 4).
- **Startup reconcile:** existing items of the producer's `source` are adopted as
  "raised", so a condition that ended while the Core was down is resolved by the
  normal recovery rule instead of staying forever.

### (a) Backup failure

- **Detection: status file written by the script.** `backup-data.ps1` writes
  `<data dir>/backup/status.json` atomically (temp + move) at start and at the end:
  `{version: 1, runId, startedAt, finishedAt?, result: running|ok|failed,
  stage?: setup|archive|upload|prune, lastSuccessAt}`. The whole script body,
  setup included, goes inside the `try`; `-WhatIf` writes nothing; the error
  message is not copied (it can hold remote names), only `stage`. The archive
  excludes this file, so a restore never brings back an old status.
  Alternatives: tailing `backup.log` (fragile text, misses setup errors) or Task
  Scheduler `LastTaskResult` (Windows-only API, no stage, no last success).
- The Core reads the file every 60 s (mtime check first). **No file = backup not
  set up = no notification.**
- **Rules** (key / urgency):
  - `result: failed` → `backup:failed`, normal; each new failed `runId` re-raises
    with `renotify: true` (one unread reminder per failed day).
  - `running` older than 2 h 15 min (task limit + margin) → `backup:failed` with
    "takıldı".
  - `lastSuccessAt` older than 26 h (daily + 2 h) and no failure explaining it →
    `backup:stale`, normal ("Yedek alınmadı": task not run, PC off at 03:30).
  - Older than 72 h → the same open item re-raised as **urgent** with `renotify`
    (spoken once). Default; see open question 1.
  - `result: ok` → resolve `backup:failed` and `backup:stale`.
- Flap: not applicable (one run per day); dedupe by `runId`.

### (b) Core services down / back

- **Detection: `HealthMonitor`, no new checks.** Covered: `home-assistant` (MCP
  endpoint), `whisper-svc`, `tts-svc`. Vault and memory are left out (open
  question 5). The producer needs to know a service *stayed* down, which
  `subscribe()` alone does not say; time-based debounce with `snapshot()` solves it
  without touching the monitor: on a change to `down`, start a timer; when it
  fires, check `snapshot()` again.
- **Thresholds:**
  - Down: `down` continuously for **90 s** (3 rounds) → raise
    `service:<name>`, title per service ("Home Assistant'a ulaşılamıyor",
    "Konuşma tanıma servisi yanıt vermiyor", "Ses servisi yanıt vermiyor"), body
    with the detail code mapped to Turkish text (`timeout`, `unauthorized`, …).
    A detail change during an outage does not reset the timer.
  - `loading` is not down; `loading` for more than **180 s** → the same key,
    normal, "yüklenemedi".
  - Back: `ok` continuously for **60 s** → resolve.
  - **Flap guard:** when the key was raised **≥ 2 times in the last 60 min**, the
    back window becomes **15 min**; while it runs a new outage only updates the
    open item (no new item, no renotify, no speech).
  - `disabled` (config change) → resolve.
- **Urgency:** whisper and TTS always normal (with TTS down the urgent speech path
  itself is broken). HA normal; after **10 min** down, re-raised as urgent with
  `renotify` (spoken once), since home control is the core function. Default;
  open question 2.

### (c) Home Assistant's own alerts

- **Detection: a read-only HA WebSocket client** (`${HA_URL}/api/websocket`, auth
  with `HA_CORE_TOKEN`, the existing `ws` package):
  - `persistent_notification/subscribe` → the current set, then added / updated /
    removed events. Key `pn:<notification_id>` (hashed when longer than 128).
    Persistent notifications are no longer entities (HA 2023.6), so REST
    `/api/states` and MCP do not see them.
  - Repairs: `repairs/list_issues` at connect and every **10 min**; key
    `repair:<domain>:<issue_id>`; ignored issues skipped. Likely admin-only:
    open question 3.
  - Title/body copied (truncated to the store limits); the user's own inbox only,
    never logged.
- **Resolve:** an id missing from a **complete** listing (subscribe snapshot or a
  successful `list_issues`) is resolved; a lost connection is never an empty list.
  Shadow never dismisses anything in HA (read-only; deleting the Shadow item does
  not touch HA).
- **Reconnect:** 1 → 2 → 4 … → 60 s with jitter. Not a new health entry: the HA
  MCP check already reports HA reachability. Only `auth_invalid` (or a
  missing-permission answer for repairs) raises one normal item `ha:access`
  ("HA uyarıları okunamıyor"), resolved on the next good connect.
- **Urgency:** normal for all; an urgent allow-list by `notification_id` / issue
  domain is open question 3.
- **Flap:** HA already dedupes by id; an update of the same id replaces the item
  without `renotify`.

### Urgent items while no client is connected (protocol change, proposed)

The confirmed delivery rule says an urgent item is always shown on its own on
connect **and spoken once**; today the catch-up never speaks, so an urgent item
raised with no speech-enabled socket (03:30, phone app closed) is never heard.
Proposal, no new frame:

- `NotificationCenter` keeps a **pending-speech** set: an urgent raise (new or
  `renotify`) with no speaker adds the item id.
- When a speech-enabled session attaches (after `welcome` / speech prefs), the
  Core sends that one socket `notification {item, speak: true}` for each pending
  id, then clears it. Read, delete or resolve on any device cancels it.
- In memory only: a Core restart drops pending speech (the item stays urgent and
  unread in the inbox).
- `docs/02` change: "a reconnect never speaks" becomes "a reconnect speaks only
  items still pending speech, once, on one socket". The client side is unchanged
  (it already speaks `speak: true` and keeps urgent items out of the summary).
  Rejected for now: a `notification_spoken` ack (stronger, but a new frame and
  client storage for a rare case).

## Tests

- Fake clock + fake center (records `raise`/`resolve`) for every producer.
- Backup: fixture status files (missing, running, ok, failed, stuck, stale,
  invalid JSON = log once, no item); for the script, a manual check with
  `-WhatIf` (no status written) and a forced failure (status `failed`, `stage`).
- Services: a fake monitor (`subscribe` + `snapshot`) driving down/ok sequences:
  89 s vs 90 s, 59 s vs 60 s, flap (3 outages in 60 min → one item, 15 min
  window), `loading` 180 s, `disabled`, HA escalation at 10 min, startup adoption.
- HA: a local `ws` server speaking the auth + subscribe + list_issues exchange:
  current set, add/update/remove, disconnect (no resolve), reconnect with a
  smaller set (resolve), `auth_invalid` → `ha:access`.
- Pending speech: session tests in `session-notifications.test.ts` style
  (no speaker → attach → spoken once; read/resolve before attach → not spoken).

## Implementation tasks

- T7.w.11.1 — Backup status file: `backup-data.ps1` writes `backup/status.json` (start/end, stage, lastSuccessAt; setup inside `try`; `-WhatIf` none; excluded from the archive); docs/05 note.
- T7.w.11.2 — Backup producer in the Core: 60 s read, `backup:failed` / `backup:stale` rules, 72 h urgent, resolve on success; tests.
- T7.w.11.3 — Service producer on `HealthMonitor`: 90 s down / 60 s back, flap guard, loading 180 s, startup adoption, HA 10 min urgent; tests.
- T7.w.11.4 — Pending speech for urgent items on attach (NotificationCenter) + docs/02 wording; tests.
- T7.w.11.5 — HA alerts client: WebSocket auth, persistent-notification subscription, reconnect with backoff, `ha:access`; tests with a local `ws` server.
- T7.w.11.6 — HA repairs: `repairs/list_issues` at connect and every 10 min, resolve on a complete listing; depends on open question 3.

11.1→11.2, 11.5→11.6 are ordered; 11.3 and 11.4 stand alone.

## Kullanıcı kararı gerekli (open questions)

1. **Backup escalation:** is "no successful backup for 72 h" urgent (spoken), or
   is a backup never urgent?
2. **HA down urgency:** urgent after 10 min down, or always normal? Should urgent
   speech have quiet hours (e.g. 23:00–07:00 → pending until the first turn)?
3. **HA token and alerts:** may `HA_CORE_TOKEN` be used for the WebSocket API too,
   and is its user an admin (repairs need it; otherwise only persistent
   notifications, or a separate token)? Which HA alerts, if any, are urgent
   (e.g. failed-login notification)?
4. **Deleted while still true:** after a Core restart an open condition the user
   deleted can come back once. Acceptable, or keep a small persisted "seen" file
   per producer?
5. **Vault / memory health:** add them to the service producer (normal), or leave
   them to `/health` only?
