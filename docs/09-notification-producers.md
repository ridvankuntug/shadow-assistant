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
  with no such socket it is pending speech (T7.w.11.4, implemented; see
  [Urgent items while no client is connected](#urgent-items-while-no-client-is-connected-protocol-change-proposed)).
- **Services.** `HealthMonitor` ([`health.ts`](../core/src/health.ts)) polls every
  `services.yaml` entry every 30 s (timeout 3 s, `CORE_HEALTH_*`); `subscribe()`
  fires only when a status or detail **changes**, `snapshot()` gives the latest
  round. Statuses: `ok` (whisper `idle` = ok), `loading`, `down` (+ detail code),
  `disabled`. Visible in `GET /health` and the `services` frame. Hysteresis
  (T7.w.13): a service is *shown* as `down` only after **2 failed checks in a
  row** (within 60 s at the 30 s interval); one good check shows `ok` again at
  once. `snapshot()` / `subscribe()` give the shown status.
- **HA / "MCP gateway".** The Core reaches HA only over MCP SSE
  (`${HA_URL}/mcp_server/sse`, `HA_CORE_TOKEN`); the gateway
  ([`mcp-gateway.ts`](../core/src/mcp-gateway.ts)) is in-process and its remote
  connection ([`mcp-direct.ts`](../core/src/mcp-direct.ts)) reconnects lazily on the
  next call. So "the gateway is down" means "the HA MCP endpoint is unreachable",
  which the health check already measures (SSE headers + token, no tool call).
  There was no HA REST or WebSocket client; since T7.w.11.5 a read-only HA
  WebSocket client ([`ha-client.ts`](../core/src/ha-client.ts)) reads HA's alerts.
- **Backup.** [`deploy/backup/backup-data.ps1`](../deploy/backup/backup-data.ps1) runs
  as a daily scheduled task (03:30, 2 h limit,
  [`install-backup-task.ps1`](../deploy/backup/install-backup-task.ps1)) outside the
  Core. Its only trace is `backup.log` under `%LOCALAPPDATA%`; since T7.w.13 setup
  errors (settings, rclone, tar, missing data dir) are logged there too and the
  script exits non-zero on any failure (the task's last result shows it). The
  Core cannot see a backup today.

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
  accepted (decision). The user gets two explicit choices, see
  [Dismiss options](#dismiss-options-gördüm-vs-tekrar-gösterme).
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
    (spoken once). Decided: no successful backup for 72 h is urgent.
  - `result: ok` → resolve `backup:failed` and `backup:stale`.
- Flap: not applicable (one run per day); dedupe by `runId`.
- Implemented (T7.w.11.2, [`backup-producer.ts`](../core/src/backup-producer.ts)). Details
  the rules above leave open: a `running` run that is not stuck changes nothing (open
  items wait for its result); a failure resolves `backup:stale` (it explains it); an
  invalid file keeps the open items, a removed file resolves them; an adopted
  `backup:failed` is renotified only if the run in the file ended after the item's
  last update.
- **Varsayılan — kullanıcı onayı bekliyor:** with `lastSuccessAt: null` (no run ever
  succeeded) the 72 h urgency counts from the earliest known start: the earliest
  `startedAt` seen since the Core started, or the `createdAt` of an open backup item
  adopted at startup. `backup:stale` needs no reference then (a failed or stuck run
  already shows `backup:failed`).

### (b) Core services down / back

- **Detection: `HealthMonitor`, no new checks.** Covered: `home-assistant` (MCP
  endpoint), `whisper-svc`, `tts-svc`, plus **vault health** and **memory
  health** (decided; normal urgency, same thresholds and keys `service:vault` /
  `service:memory`; title and body in Turkish like the others). The producer needs to know a service *stayed* down, which
  `subscribe()` alone does not say; time-based debounce with `snapshot()` solves it
  without touching the monitor: on a change to `down`, start a timer; when it
  fires, check `snapshot()` again.
- **Timing with the monitor's hysteresis:** the producer sees the *shown* status,
  so its timers start when `down` is shown, i.e. at the second failed check in a
  row. At the default 30 s interval a real outage is shown 30-60 s after it
  began and raised 90 s later (about 2-2.5 min in total); a single lost check
  never starts the timer. Recovery is not delayed by the monitor (one good
  check), so the 60 s "back" window is two good rounds. The thresholds below
  stay as written and count from the shown change, not from the first failed
  check; with `CORE_HEALTH_INTERVAL_MS` raised, both delays grow with it.
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
- **Urgency:** whisper, TTS, vault and memory always normal (with TTS down the
  urgent speech path itself is broken). HA: the item is raised **normal** at
  90 s as above; when HA has been down for **30 min** without a break (decided),
  the same open item is re-raised as **urgent** with `renotify` (spoken once,
  subject to [quiet hours](#quiet-hours-for-urgent-speech)). The 30 min count
  starts with the shown `down` and restarts after a recovery.
- Implemented (T7.w.11.3, [`service-producer.ts`](../core/src/service-producer.ts)):
  covered by services.yaml name (`home-assistant`, `whisper-svc`, `tts-svc`,
  `shadow-vault` → `service:vault`, `shadow-memory` → `service:memory`); one timer
  for the earliest deadline, `snapshot()` re-read when it fires; a failed store
  call is retried for that key after 60 s. Startup adoption: open `service` items count as
  raised (an urgent HA item as already escalated).
- **Varsayılan — kullanıcı onayı bekliyor:**
  - Texts: vault "Not kasasına (vault) ulaşılamıyor", memory "Hafıza deposu
    kullanılamıyor"; "yüklenemedi" title `<servis> yüklenemedi`; detail codes as
    short Turkish sentences (`timeout` "Sağlık kontrolü zaman aşımına uğradı.",
    `http_<n>` "Servis HTTP <n> yanıtı verdi.", unknown "Servis yanıt vermiyor.").
  - While an item is open (any back window, not only the flap one) a new outage
    updates it at once (text only, no renotify), without a new 90 s wait.
  - Flap guard counts new items only (not the HA urgent re-raise), over the hour
    before the `ok` period started; the window length is fixed then.
  - HA: any shown non-`down` status (one good check) is a break that restarts
    the 30 min; the urgent re-raise also happens during a flap back window.
  - A covered service missing from the snapshot (removed from services.yaml)
    resolves like `disabled`; `loading` counts as "more than 180 s" (strict).
  - An open item the user deleted is not recreated by a text update (detail
    change, new outage in the back window) until the condition resolves; the HA
    30 min urgent re-raise still recreates it (spoken once).

### (c) Home Assistant's own alerts

- **Detection: a read-only HA WebSocket client** (`${HA_URL}/api/websocket`, auth
  with `HA_CORE_TOKEN`, the existing `ws` package):
  - `persistent_notification/subscribe` → the current set, then added / updated /
    removed events. Key `pn:<notification_id>` (hashed when longer than 128).
    Persistent notifications are no longer entities (HA 2023.6), so REST
    `/api/states` and MCP do not see them.
  - Repairs: `repairs/list_issues` at connect and every **10 min**; key
    `repair:<domain>:<issue_id>` (hashed when longer than 128); ignored issues
    skipped. Admin-only; allowed, see below.
  - Access: `HA_CORE_TOKEN` belongs to an **admin** user (decided) and is used
    for both the WebSocket API and repairs access (the token value is never
    written anywhere).
  - Title/body copied (truncated to the store limits); the user's own inbox only,
    never logged.
- **Resolve:** an id missing from a **complete** listing (subscribe snapshot or a
  successful `list_issues`) is resolved; a lost connection is never an empty list.
  Shadow never dismisses anything in HA (read-only; deleting the Shadow item does
  not touch HA).
- **Reconnect:** 1 → 2 → 4 … → 60 s with jitter. Not a new health entry: the HA
  MCP check already reports HA reachability. Only `auth_invalid` (or a
  missing-permission answer for repairs) raises one normal item `ha:access`
  ("HA uyarıları okunamıyor"), resolved once both causes are known good (an
  authenticated connection plus a `list_issues` answer that is not `unauthorized`).
- **Urgency:** learned per alert type, see
  [Learned urgency of HA alerts](#learned-urgency-of-ha-alerts-t7w1110); normal
  unless a type is on the learned urgent list.
- **Flap:** HA already dedupes by id; an update of the same id replaces the item
  without `renotify`.
- Implemented (T7.w.11.5, persistent notifications only; repairs are T7.w.11.6):
  [`ha-client.ts`](../core/src/ha-client.ts) (connection, auth, backoff, only the
  commands in `READ_ONLY_COMMANDS` can be sent; T7.w.11.6 adds `repairs/list_issues`
  there) and [`ha-producer.ts`](../core/src/ha-producer.ts) (keys, resolve on a
  complete listing, `ha:access`, startup adoption of open and suppressed keys;
  urgency in one function `haAlertUrgency`, normal until T7.w.11.10). Wired in
  `index.ts` (off with one info line when `HA_URL` or `HA_CORE_TOKEN` is empty;
  closed in the shutdown chain). No new setting. Tests with a local fake HA
  WebSocket server in `core/test/ha-producer.test.ts`.
- Implemented (T7.w.11.6, repairs): `repairs/list_issues` added to
  `READ_ONLY_COMMANDS` (still nothing that writes, ignores or fixes). The producer
  lists on every authenticated connection once the notification subscription is
  accepted, then 10 min after each answer while connected (stopped on
  disconnect). Ignored issues (`ignored: true`; when that field is missing, a set
  `dismissed_version`) are skipped, so ignoring an issue in HA resolves its item.
  `ha:access` now has two causes (token rejected, `unauthorized` list answer) and
  is resolved only when both are known good; adoption covers `repair:` items and
  suppressed `repair:` keys. Urgency through `haAlertUrgency` (normal). Tests in
  `core/test/ha-producer.test.ts` (fake server on 127.0.0.1).
- **Varsayılan — kullanıcı onayı bekliyor:**
  - **Resolve grace 60 s:** an id missing from a `current` listing is resolved
    only if still missing 60 s after it (a `removed` event resolves at once). HA
    serves its WebSocket API early while starting and keeps persistent
    notifications in memory only, so the first listing after an HA restart can
    lack notifications its integrations recreate moments later; resolving at once
    would clear "Tekrar gösterme" records and bring the items back unread. Not
    chosen (more code, an extra read-only command): waiting for HA's `RUNNING`
    state via `get_config`. To check against a real HA restart.
  - Jitter ± 20 % of the delay (1 s → 0.8-1.2 s, 60 s → 48-72 s); the delay starts
    over after the first successful command answer on a connection (not at
    `auth_ok`, so an HA that accepts and drops at once still backs off).
  - `auth_invalid` keeps retrying with the same backoff (up to every ~60 s); the
    token comes from `.env`, so a fixed token needs a Core restart anyway.
  - A long id is hashed as `pn:sha256:<64 hex>`; an HA notification without a
    title gets "Home Assistant bildirimi"; title/body are trimmed and cut like the
    store (200 / 2000), without leaving half a surrogate pair.
  - An HA update of an item the user deleted ("Gördüm") recreates it (unread,
    without renotify): the update is new content. An unchanged update or the same
    set after a reconnect writes nothing, so a deleted item does not come back by
    a reconnect.
  - A malformed entry inside a `current` listing still counts as present
    (fallback title, empty body), so it is never resolved by mistake; a `current`
    event whose `notifications` is not an object is not a complete listing (ignored,
    logged once).
  - Dead links: a protocol-level ping (no HA command) every 30 s; no pong by the
    next ping drops the socket. Handshake and auth answer timeouts 10 s; frames
    over 8 MiB are refused.
  - Logs hold counts and fixed texts only (no notification ids, titles, bodies,
    URL, token or HA error messages).
  - **Repairs (T7.w.11.6):**
    - **Text:** `list_issues` carries no human text, so the item is built in
      Turkish from codes only: title `Home Assistant onarımı: <issue_domain or
      domain>`; body lines `Sorun: <translation_key, else issue_id>`, `Önem:
      kritik / hata / uyarı` (unknown severity left out), `Home Assistant <v>
      sürümünde çalışmayı bırakacak.` (when `breaks_in_ha_version` is set), `Home
      Assistant'ta onarma adımı var.` (when `is_fixable`), and `Ayrıntılar: Home
      Assistant > Ayarlar > Onarımlar.` `translation_placeholders` values and
      `learn_more_url` are never copied (they can hold names or addresses), so the
      text is generic; HA's own translated text would need an extra read-only
      command (`frontend/get_translations`), not chosen.
    - **Resolve grace:** HA restores non-persistent issues as inactive at start
      until their integration recreates them, so the list right after a
      (re)connect raises but never resolves; only a list started 60 s or more after
      the connection's auth resolves missing keys (in practice the 10-min list).
      An issue that ended while the Core was down is therefore resolved about 10
      min after start.
    - A failed call, an answer whose `issues` is not a list, or a list with a
      malformed entry (no `domain` / `issue_id`) resolves nothing (logged once,
      codes only); a lost connection is never taken as an empty list (only keys
      missing from the last successful complete list are resolved).
    - `ha:access`: an `unauthorized` list answer opens it (body says repairs need an
      admin user); any other error counts as permission present (HA checks admin
      first). Open while either cause holds, resolved only after an authenticated
      connection **and** a non-`unauthorized` list answer on it, so a good connect
      does not clear a repairs refusal (no flap at startup). When the cause changes
      the text is updated without renotify. The list is sent only after the
      notification subscription is accepted (otherwise its answer would reset the
      client's backoff while the refused subscription keeps dropping the
      connection); so while HA keeps refusing that subscription, an open
      `ha:access` stays open with its last text (HA alerts are unreadable then
      anyway).
    - The poll interval counts from each answer (not a fixed clock); a refused
      list keeps polling every 10 min, so granting admin is picked up without a
      restart.

#### Learned urgency of HA alerts (T7.w.11.10)

Decided: which HA alerts are urgent is learned over time, with the user's consent
each time. Design only; no code yet.

- **Start:** HA's failed-login notification is urgent (e.g. the `http.login_attempts`
  / `ip_ban` persistent notification; candidate names, to be confirmed against a
  real HA before coding). Every other HA alert is normal.
- **Alert type key** (proposal): persistent notifications use `pn:<notification_id>`
  with a variable suffix stripped (normalized prefix, e.g. `http-login`, not
  `http-login-<n>`); repairs use `repair:<domain>:<translation_key>`, falling back
  to `issue_id` when there is no `translation_key`. Reason: the type must survive
  a new id per occurrence, while two different problems of one integration stay
  apart. Never title/body text (language- and content-dependent).
- **Feedback** on an HA item: "Bu acildi" / "Acil değildi". Proposal, weaker
  signals from the user's reaction: opening the item within a short time (e.g. 2
  min) counts as "acildi"; "Tekrar gösterme" counts as "acil değildi". Whether
  reactions count at all is open question 3; explicit buttons are the baseline.
- **Learning** follows the rule learning of
  [`08-learning-fast-path.md`](08-learning-fast-path.md#t7w2-pattern-learning)
  (observe, suggest in the Development tab, user approves): per type the store keeps a
  direction (`urgent` / `normal`) and a counter. A signal in the same direction
  adds 1; an **opposite** signal resets the counter to 1 in the new direction.
  At **3** signals in one direction (docs/08 `min_observations`) the Development
  tab shows a suggestion "X türü acil sayılsın mı?" (or "acil saymayalım mı?").
  Reason for 3: one tap is noise, and a restart on a flip is docs/08's
  conflict rule without its `blocked` state, since HA alert types are few and
  the user may change their mind.
- **Approval:** only "Kabul" on the suggestion changes the type; "Yok say" keeps
  it and clears the counter. Shadow never makes a type urgent (or spoken) by
  itself; lowering urgent to normal goes the same way. A type's urgency is read
  at raise time; an open item keeps its urgency until re-raised.
- **Quiet hours, dedupe and speech** apply to learned-urgent items as to any
  urgent item (see below); the failed-login start is no exception.
- **Record:** type key, direction, counter, approved level; no title/body, no
  secrets (like the suppression record). Where it lives is open question 5.

### Urgent items while no client is connected (protocol change, proposed)

Implemented (T7.w.11.4): `NotificationCenter.speechOn()`, called by the session
when its speech turns on (first `speech_prefs` with `enabled:true`, or on
again); the speaker check for the raise path and pending speech is one method
(`canSpeak`), where quiet hours (T7.w.11.9, implemented) are applied. docs/02 updated.

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

### Quiet hours for urgent speech

Decided: **00:00-09:00** (Core host local time) is quiet. In that window an
urgent item is **not spoken**: it is raised, broadcast and shown like any item
(the phone shows it as an urgent notification), but no socket gets
`speak: true`, neither at raise time nor by the pending-speech catch-up on
connect. Outside the window nothing changes.

- Applied in one place: `NotificationCenter`'s speaker choice (the same check
  for the raise path and for pending speech), with an injected clock for tests.
  The window is a Core setting with this default.
- Normal items are never spoken, so quiet hours do not touch them.

Decided (T16.3, was open question 1): an urgent item raised in quiet hours
goes to the pending-speech set. At 09:00 nothing is spoken by itself (no device
is known to be near a person); the **first speech-enabled connection after
09:00** speaks it **once**, on one socket, if it is still unread and unresolved
(and not suppressed). Read, delete or resolve before then cancels it; after it
was spoken once it is never spoken again. Not chosen: never speaking it later.

Implemented (T7.w.11.9): `NotificationCenter` option `quietHours` (+ injected
`now` clock), checked in `canSpeak`, the one speaker check of the raise path
and `speechOn()`; inside the window `speechOn()` stops before using any pending
id up. Core setting `CORE_QUIET_HOURS` (`HH:MM-HH:MM`, Core host local time,
start included, end excluded, may cross midnight; `off` = none), wired in
`index.ts`; `.env.example`, docs/02 and docs/05 updated. "Not suppressed" is
checked too since T7.w.11.7: a suppressed key is never raised, so it never becomes pending.

- A socket already connected with speech on when the window ends speaks
  nothing by itself: the pending items are spoken on the next speech-enabled
  connection (or speech turned on again). A later urgent raise outside the
  window is spoken as usual (that item only).
- **Varsayılan — kullanıcı onayı bekliyor:** an unset or **blank**
  `CORE_QUIET_HOURS` means the default 00:00-09:00 (like every blank line in
  `.env.example`); only `off` / `0` / `false` / `no` / `none` disables it.
- **Varsayılan — kullanıcı onayı bekliyor:** an invalid value (bad format, hour
  over 23, minute over 59, start equal to end) uses the default and logs one
  warning at startup; the Core still starts.
- **Varsayılan — kullanıcı onayı bekliyor:** minute precision; 08:59:59 is still
  quiet, 09:00:00 is not. A clock that fails counts as not quiet.

### Dismiss options: "Gördüm" vs "Tekrar gösterme"

Decided: a deleted item may come back once after a Core restart while the
condition lasts (no per-producer "seen" file). The inbox UI offers two separate
actions, so the user can choose:

- **"Gördüm":** deletes the item. If the condition persists it can return once
  when Core restarts (producer memory is lost).
- **"Tekrar gösterme":** suppresses the key while the condition lasts. A small
  **persisted** suppression record (per `source` + `key`, no title/body, no
  secrets) is kept. When the condition is seen resolved, the record is removed,
  so a new occurrence is shown again. While suppressed, the producer neither
  raises nor renotifies nor speaks the key; the suppression is applied in the
  `NotificationCenter` raise path so every producer gets it. At startup a
  producer adopts its suppressed keys like its open items, so a condition that
  ended while the Core was down still clears the record.

The client action and its protocol shape (extra to delete) are specified in
`docs/02` when implemented.

Implemented (T7.w.11.7, Core only; the UI is T7.w.11.8): `notification_action`
`action:"suppress"`, advertised by the feature `notifications_suppress`
([docs/02](02-core-protocol.md#notifications)). It deletes the item like
`delete` (same broadcast) and records `{source, key, at}` in
`<SHADOW_DATA_DIR>/notifications/suppressed.json`
([`notification-suppressions.ts`](../core/src/notification-suppressions.ts),
atomic writes). `NotificationCenter.raise` answers `suppressed` for a recorded
key (nothing created, broadcast, spoken or pending); `resolve(source, key)`
removes the record. Producers adopt `NotificationCenter.suppressed()` at
startup as open keys and count a `suppressed` raise as open, so recovery still
resolves (and clears) them. Tests in `core/test/notification-suppressions.test.ts`.

- **Varsayılan — kullanıcı onayı bekliyor:** the protocol shape is a new
  `action` value on the existing `notification_action` frame (not a new frame),
  plus the feature name `notifications_suppress` so a client shows the button
  only on a Core that supports it.
- **Varsayılan — kullanıcı onayı bekliyor:** `suppress` on a keyless item (a
  one-off item, nothing can recur) only deletes it; no record, no error.
- **Varsayılan — kullanıcı onayı bekliyor:** an unreadable or invalid
  `suppressed.json` means "nothing suppressed" (items are shown again, never
  lost); an invalid one is quarantined, an unreadable one is never overwritten
  and changes made meanwhile (additions and removals) are kept in memory and
  applied once it can be read; a producer does not adopt "nothing suppressed"
  but keeps running (only an unreadable inbox blocks its startup adoption),
  logs the unreadable suppression list once and re-reads it on later rounds,
  adopting its keys once it can be read. At most 1000 records (a new one beyond is not recorded, logged).
- **Varsayılan — kullanıcı onayı bekliyor:** no expiry: a record stays until
  its producer resolves the key (a key no producer resolves any more, e.g. a
  removed service, stays suppressed).

## Tests

- Fake clock + fake center (records `raise`/`resolve`) for every producer.
- Backup: fixture status files (missing, running, ok, failed, stuck, stale,
  invalid JSON = log once, no item); for the script, a manual check with
  `-WhatIf` (no status written) and a forced failure (status `failed`, `stage`).
- Services: a fake monitor (`subscribe` + `snapshot`) driving down/ok sequences:
  89 s vs 90 s, 59 s vs 60 s, flap (3 outages in 60 min → one item, 15 min
  window), `loading` 180 s, `disabled`, HA escalation at 30 min (29:59 vs 30:00,
  restarted by a recovery), startup adoption, vault/memory checks.
- Quiet hours: fake clock at 23:59, 00:00, 08:59 and 09:00; an urgent raise in
  the window is broadcast without `speak`; pending speech is not spoken on a
  connect inside the window (kept, spoken once on the first speech-on after
  09:00; read or resolved before then → not spoken); `CORE_QUIET_HOURS` parsing.
- HA: a local `ws` server speaking the auth + subscribe + list_issues exchange:
  current set, add/update/remove, disconnect (no resolve), reconnect with a
  smaller set (resolve), `auth_invalid` → `ha:access`.
- Suppression: "Tekrar gösterme" persists across a restart and blocks raise;
  condition resolves → record removed → next raise shown; "Gördüm" does not
  persist.
- Pending speech: session tests in `session-notifications.test.ts` style
  (no speaker → attach → spoken once; read/resolve before attach → not spoken).

## Implementation tasks

- T7.w.11.1 — Backup status file: `backup-data.ps1` writes `backup/status.json` (start/end, stage, lastSuccessAt; setup inside `try`; `-WhatIf` none; excluded from the archive); docs/05 note.
- T7.w.11.2 — Backup producer in the Core: 60 s read, `backup:failed` / `backup:stale` rules, 72 h urgent, resolve on success; tests. Implemented: [`backup-producer.ts`](../core/src/backup-producer.ts), wired in `index.ts` (started with the health monitor, closed in the shutdown chain); tests in `core/test/backup-producer.test.ts`.
- T7.w.11.3 — Service producer on `HealthMonitor` (shown status, after its 2-check hysteresis): 90 s down / 60 s back, flap guard, loading 180 s, startup adoption, vault/memory health; HA urgent after 30 min down; tests. Implemented: [`service-producer.ts`](../core/src/service-producer.ts), wired in `index.ts` (started after the health monitor, closed in the shutdown chain); tests in `core/test/service-producer.test.ts`.
- T7.w.11.4 — Pending speech for urgent items on attach (NotificationCenter) + docs/02 wording; tests. Implemented.
- T7.w.11.5 — HA alerts client: WebSocket auth, persistent-notification subscription, reconnect with backoff, `ha:access`; tests with a local `ws` server. Implemented: [`ha-client.ts`](../core/src/ha-client.ts) + [`ha-producer.ts`](../core/src/ha-producer.ts), wired in `index.ts` (started after the service producer, closed in the shutdown chain); tests in `core/test/ha-producer.test.ts` (see *(c)*, defaults awaiting approval there).
- T7.w.11.6 — HA repairs: `repairs/list_issues` at connect and every 10 min, resolve on a complete listing; token is admin (decided), so repairs are in scope. Implemented: [`ha-producer.ts`](../core/src/ha-producer.ts) (+ allow-list in [`ha-client.ts`](../core/src/ha-client.ts)); tests in `core/test/ha-producer.test.ts` (see *(c)*, repairs defaults awaiting approval there).

- T7.w.11.7 — "Tekrar gösterme" in Core: persisted suppression record (`source`+`key`), applied in the `NotificationCenter` raise path, removed when the condition resolves (startup adoption included); protocol action + docs/02; tests. Implemented: `notification_action` `suppress` + feature `notifications_suppress`, [`notification-suppressions.ts`](../core/src/notification-suppressions.ts), adoption in both producers (see *Dismiss options*, defaults awaiting approval there); tests in `core/test/notification-suppressions.test.ts`.
- T7.w.11.8 — Inbox UI: two separate actions "Gördüm" (delete; may come back once after a Core restart while the condition lasts) and "Tekrar gösterme" (suppressed while the condition lasts; shown again when it resolves and recurs); client tests.
- T7.w.11.9 — Quiet hours 00:00-09:00 for urgent speech in `NotificationCenter` (raise path and pending speech), a Core setting with this default; the after-09:00 behaviour as decided in *Quiet hours* (spoken once on the first speech-enabled connection after 09:00); tests with a fake clock. Implemented: `canSpeak` + `CORE_QUIET_HOURS` (see *Quiet hours for urgent speech*, defaults awaiting approval there); tests in `core/test/quiet-hours.test.ts` and `session-notifications.test.ts`.

- T7.w.11.10 — Learned urgency of HA alerts: alert type key, feedback ("Bu acildi" / "Acil değildi"), counter (3 same-direction signals, opposite resets), Development-tab suggestion and approval, failed-login as the initial urgent type; record store; tests.

11.1→11.2, 11.5→11.6, 11.7→11.8, 11.4→11.9, 11.5→11.10 are ordered; 11.3 stands alone.

## Kullanıcı kararı gerekli (open questions)

Decided (moved to the sections above): 72 h without a successful backup is
urgent (spoken); HA down for 30 min is urgent (the item raised at 90 s stays
normal until then); quiet hours 00:00-09:00, in which urgent items are shown but
not spoken, and an urgent item from that window that is still unread and
unresolved is spoken once on the first speech-enabled connection after 09:00; `HA_CORE_TOKEN` belongs to an admin user and is used for the
WebSocket API and repairs; "Gördüm" deletes (the item may come back once after a
Core restart while the condition lasts, accepted) and "Tekrar gösterme"
suppresses it while the condition lasts; vault and memory health join the
service producer.

1. ~~**After quiet hours**~~ — decided (T16.3): spoken once on the first
   speech-enabled connection after 09:00 if still unread and unresolved; see
   *Quiet hours for urgent speech*.
2. **Alert type key:** is the proposed key (normalized `notification_id` prefix;
   repairs `domain` + `translation_key`/`issue_id`) right, and how is a variable
   suffix recognized (digits/UUID tail)?
3. **Reaction signal:** do reactions (opening quickly, "Tekrar gösterme") count
   as feedback, or only the explicit "Bu acildi" / "Acil değildi" buttons?
4. **Threshold:** is 3 same-direction signals (opposite resets) right for HA
   alerts, or should it differ from docs/08?
5. **Where the record lives:** a separate small persisted file next to the
   suppression record, or the same store?

(HA alerts urgency is decided: learned, see T7.w.11.10.)
