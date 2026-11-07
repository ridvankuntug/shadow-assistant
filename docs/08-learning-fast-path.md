# 08 - Learning fast path, Development tab and notifications

Status: design (T7.w in the vault plan). T7.w.1 (number normalization) is being
implemented separately and is only used here as an input. Builds on
[`04-router.md`](04-router.md) (tiers, tier 0), [`02-core-protocol.md`](02-core-protocol.md)
(frames, permission gate, Core MCP gateway) and [`07-speed.md`](07-speed.md)
(persistent sessions, atomic files).

Examples use generic names ("salon lambası", "mutfak prizi"). Nothing here, and
nothing the implementation commits, may hold real room, device or person names,
addresses or tokens.

## Problem

Tier 0 ([`direct.ts`](../core/src/direct.ts), rules in [`router.yaml`](../router.yaml))
turns a light on or off in about 0.2 s without a model. Anything the hand-written
patterns do not cover goes to tier 1 (Haiku, 1.7 to 2.5 s, about $0.0003 per turn),
even when the model then makes one simple, predictable call. Observed on a phone
(8 turns): brightness requests went to Haiku three times; one was a mis-heard
"yüzlü", which Haiku still resolved.

Writing patterns by hand for every phrasing does not scale. The Core can learn
them from turns the model has already solved, but only under the user's control,
and only for low-risk devices.

Next to that, the Core has no place to tell the user "something needs a look"
(a suggested rule, a missing tool, a failing tool) and no general notification
store for later producers (backup errors, a service going down, HA events, the
case battery reminder of T11-B).

## Scope

| In | Out |
|---|---|
| Learning tier-0 rules from single-action model turns (T7.w.2) | Multi-call turns, relative changes ("biraz kıs"), area-wide calls, scenes, timers |
| Lights, brightness, plugs, media on/off (T7.w.2) | Locks, alarms, doors, covers, valves, garage, climate: never |
| Dev-notes for turns: rule suggestion, missing capability, wandering, tool error (T7.w.3) | Changing the existing `tools.json` note kinds |
| Development tab in the UI, counts in the tray (T7.w.4) | Push or sound for development items; a native tray window |
| Generic notification store, UI inbox, tray count, phone notification while connected (T7.w.5) | Delivery to a phone whose app is not connected ([decision 1](#kullanıcı-kararı-gerekli-decisions-for-the-user)); the T11-B reminder itself |
| Closing the remaining test gaps for built-in tools (T7.w.6) | – |
| Decision on contextual commands (T7.w.7): deferred | Implementing "last device" context |

## Current state (what the design relies on)

- **Routing.** `TieredRouter.route()` ([`router.ts`](../core/src/router.ts)) runs
  `prepareText()` and `matchRules()` ([`router-config.ts`](../core/src/router-config.ts)):
  rules in file order, first match wins; tier-0 hits return a `DirectPlan`. No hit →
  tier 1 with `rule: "default"` (or tier 2 `long_input`). `CORE_ROUTER=off` uses
  `PassthroughRouter` (no tier 0).
- **Tier-0 executor.** `runDirectPlan()` reads `homeassistant__GetLiveContext`,
  resolves `<ad>` with `resolveWithAliases()` / `resolveDevice()`
  ([`live-context.ts`](../core/src/live-context.ts)) restricted to the rule's
  `domains`, then calls `intent__HassTurnOn/Off` or `light__HassLightSet` with
  `name`, `area?`, `domain: [entity.domain]`, `brightness?`. Unresolved names and
  `isError` results fall back to the model (`on_tool_error: fallback`); an
  unreachable service, a denial or a declined confirmation replies and never
  falls back.
- **One gate.** Every tier-0 call goes through `Session.runDirect()` →
  `GatedCall` → `Session.authorize()`, the same gate the model's calls use
  (`services.yaml` levels, `confirm_inputs` on `domain` / `device_class`,
  `CORE_READ_ONLY`, confirmation flow). A rule's `permission` can only raise the
  level. A successful tier-0 turn is told to the model with `addDirectNote()`.
- **Model turn records.** `Session.authorize()` sees every tool call with its
  input; `toolFinished()` sees each result's `isError`; `recordModelUsage()` gets
  the tool names at `settled`. Nothing keeps the input of a model call past the
  gate today, and `UsageRecord` has no arguments.
- **Dev-notes.** [`dev-notes.ts`](../core/src/dev-notes.ts): one file
  `<SHADOW_DATA_DIR>/dev-notes/tools.json` (version 1), written by the MCP
  gateway on each fresh tool list; kinds `new_tool`, `tool_added`, `tool_removed`,
  `rule_unmatched`; names and levels only; a repeat bumps `count` at most once per
  hour (`DEFAULT_TOUCH_MS`). Not read by any UI.
- **Atomic files.** [`atomic-file.ts`](../core/src/atomic-file.ts):
  `writeFileAtomic()`, `readJsonOrQuarantine()`; read-modify-write serialized on
  one promise chain per store (`DevNotes`, `DeviceStateStore`).
- **Clients.** The UI talks to the Core over the WebSocket only (token in `hello`);
  memory uses request/answer frames (`memory_list` → `memory`) behind a
  `welcome.features` flag; service health is broadcast to every authenticated
  socket (`services`). The only HTTP routes are `GET /health` (no auth) and
  `POST /device/state` (bearer device token). `authenticate()` maps a token to a
  device name; there is no notion of an admin device, and `hello.client` is only
  what the client says about itself.
- **Tray** ([`deploy/windows/tray/src/ShadowTray`](../deploy/windows/tray/src/ShadowTray)):
  a context menu, no window. It polls `GET /health` over loopback every 5 s
  (`CoreHealth.cs`, `HealthPoller.cs`), serves the built UI on
  `http://localhost:<port>/` (`UiServer.cs`), opens it in the browser and shows
  balloons (`TrayApp.cs`), and reads only non-secret keys from `.env`
  (`DotEnv.cs`). It has no device token.
- **Android.** The WebView UI holds the WebSocket while the app runs;
  `MainActivity.onPause()` pauses the WebView, so the socket is not reliable in
  the background and gone after `onDestroy()`.
  [`Notifier.kt`](../android/app/src/main/java/app/shadowassistant/android/Notifier.kt)
  has one high-importance channel and one fixed notification id, used by the UI
  (`adapter.notify`) for confirmation requests while the app is in the
  background. There is no FCM and no background connection; the only background
  piece is the T11 broadcast receiver + WorkManager job.
- **Built-in tools.** `tools: []`, `disallowedTools: DENIED_BUILTIN_TOOLS`,
  `settingSources: []`, `strictMcpConfig`, `canUseTool: gatewayToolGuard(...)`
  in `buildOptions()` / `buildPersistentOptions()` ([`agent.ts`](../core/src/agent.ts))
  and `buildOneShotOptions()` ([`one-shot.ts`](../core/src/one-shot.ts), moved out of
  `index.ts` by T7.w.6a); the session
  gate denies any non-`mcp__` name (`identifyTool().builtin` → `deny`).

## T7.w.1 Number normalization (input only)

Implemented in parallel; not designed here. This document needs one property:

> The text the learner turns into a pattern is **exactly** the text the router
> matched on (after number normalization, `prepareText()` and filler removal).

If the learner normalized differently, a learned pattern would never match the
utterance it came from. The implementation must use the router's own prepared
text (passed along with the route decision, or produced by the same single
function). Numbers in that text are plain digits ("yüzlü", "yüzde yüz", "%100"
→ `100`; "yüzde elli" → `50`), so the learner only looks for digit tokens.

The normalizer should expose a version number (a constant bumped when its output
changes). Learned rules record it (see [Data file](#data-file)).

## T7.w.2 Pattern learning

### Decision

A learned rule is **an ordinary tier-0 rule that was written by the Core instead
of by hand**: one pattern in the existing pattern language (literal words, `<ad>`,
`<sayi>`), one tool the tier-0 executor already runs, a domain list. It is
compiled with `compilePattern()`, matched like a static rule, and executed by
`runDirectPlan()` through `Session.runDirect()`. The permission gate, the
confirmation flow, the live-context name resolution, the alias retry, the
fallback rules and the `addDirectNote()` record are therefore the existing code
paths, not new ones.

Learned rules:

1. are tried **only when no router.yaml rule matched** (after the whole static
   rule list, before the `long_input` / `default` fallthrough);
2. are learned **only from turns the router sent to the model by default**
   (no rule matched);
3. become `candidate` after `min_observations` (default 3) observations of the
   same pattern with the same outcome, and `active` **only** after the user
   presses "Kuralı ekle" in the Development tab;
4. are limited to a code-level allow list of tools, entity domains and target
   checks that router.yaml can narrow but never widen.

(The plan writes the slots as `{N}` and `{ad}`; in the pattern language they are
`<sayi>` and `<ad>`, because `{…}` already means "alternatives". The UI shows
them as "‹sayı›" and "‹cihaz›".)

### Alternatives considered

- **Generalize to word groups** (learn "yap" and offer `{@set-to}`). More hits,
  but a wrong generalization is silent and hard to review. Rejected: each literal
  phrasing is learned on its own; three repetitions are cheap.
- **Generic "replay the model's call" executor** (store the tool and an argument
  template, call any tool). Covers media pause/volume at once, but skips the name
  resolution and domain filter of `runDirectPlan()` and needs its own argument
  validation per tool. Rejected for v1; media beyond on/off is a later task with
  typed, per-tool executor steps ([Deferred](#out-of-scope-and-deferred)).
- **Write learned rules into router.yaml.** router.yaml is committed and must not
  contain anything from the user's home. Rejected: learned rules live in the data
  dir.
- **Ask the model to propose rules.** Costs tokens and is not reproducible.
  Rejected: extraction is deterministic code.
- **Activate automatically after N observations.** Rejected by the plan: user
  approval is required. Three observations are evidence that the phrasing is
  stable, not that it is safe; safety comes from the allow list and the gate.

### Router order

```
prepared text
  → router.yaml rules (tier 0, 1, 2, 3; unchanged, first match wins)
  → learned rules with status `active` (stable order: oldest activation first)
  → long_input / default (unchanged)
```

Because learned rules come after every static rule, an utterance that tier 0
handles today (light on/off in 0.2 s) can never be taken over by a learned rule,
a learned rule never hides a tier-2/3 rule, and a static tier-0 rule that falls
back goes to the model as today (no second, learned attempt). The router gets the
active rules as an in-memory snapshot (swapped when the store changes), so
activation needs no restart and routing stays pure and synchronous.

`RouteDecision` gets an explicit `source: "static" | "learned" | "default" |
"long_input"` so the session does not infer behaviour from rule id strings. A
learned hit returns the same shape as a static tier-0 hit, with `source:
"learned"`, `rule: "learned:<id>"`, `fallbackOnError: true` (always, independent
of `direct.on_tool_error`) and the same `TIER0_MAX_CHARS` limit. Learned rules
are off when `CORE_ROUTER=off`, `direct.enabled: false` or `learning.enabled:
false`.

### Which turns are observed

The session collects, per user turn, the calls the gate saw (`authorize()` has the
tool name and input; `toolFinished()` the `isError`) across all attempts of the
turn (an escalated turn has two). The arguments stay in memory for the turn only.
After the turn has **settled** (all `AttemptHandle.settled` promises, not
`assistant_done`; docs/07 §Turn boundaries), the learner gets one observation when
**all** of these hold:

| Condition | Why |
|---|---|
| `source: "default"` | no static rule matched; a static tier-0 fallback is a name problem, not a missing pattern |
| outcome `done`; not cancelled, no timeout, no usage limit | only successful turns teach |
| exactly one action call in the whole turn; besides it at most `homeassistant__GetLiveContext` reads | "one simple call"; the reads are what the executor itself does |
| every call allowed by the gate; the action at level `write` (not `confirm`, not denied) | a call that needed a confirmation is never learned |
| action result present and not `isError` | the model's call worked |
| action tool and target pass the [safety checks](#safety-allow-list-default-deny) | default deny |
| `CORE_READ_ONLY` off; prepared text not empty and ≤ `TIER0_MAX_CHARS` | same limits as matching |

The observation is processed off the turn path (`Session.track()`), so it never
adds latency.

### Extraction algorithm

Input: the prepared text (folded words + display form), the action call
(`tool`, `args`), a fresh live context. The learner reads
`homeassistant__GetLiveContext` itself through the direct MCP client after
checking that the policy level of that tool is `read` (no prompt is possible; it
is the same read tier 0 does).

1. **Explain every argument or give up.** Allowed argument keys: `name`,
   `domain`, and the tool's numeric key (`brightness` for `light__HassLightSet`).
   `area` is allowed only next to `name` (the executor adds it when the name was
   matched through an area). Any other key (`floor`, `color`, `device_class`, …),
   or a call with `area` but no `name` (an area-wide call) → no observation
   (`unexplained_arg` / `area_target`).
2. **Name slot first.** For every contiguous span of 1..`direct.max_name_words`
   words (skipping spans in `stop_names` or holding a `name_stop_words` word),
   **dry-run** the plan the candidate pattern would produce:
   `resolveWithAliases()` with the learnable domains and keywords, then the same
   argument building as `runDirectPlan()`, without calling anything. A span is
   good when the produced `(name, area, domain)` equals the model's arguments
   (folded strings, `domain` as a set) and resolves to exactly one entity.
   Exactly one good span → it becomes `<ad>`. None (the target is not in the
   utterance, e.g. "yüzde elli yap") or more than one → no observation
   (`name_not_in_text` / `name_ambiguous`). If the call has no `name`, the
   pattern has no `<ad>`. Names are found before numbers so the digit in a name
   like "Lamba 2" is never taken for a brightness.
3. **Number slot.** Among the words outside the name span: if the tool has a
   numeric key, its value must appear as exactly one digit token, in range
   (0..100 for brightness); that token becomes `<sayi>`. A numeric argument not
   in the text ("biraz kıs" → 30) → `number_not_in_text`. A digit token no
   argument explains ("iki dakika sonra") → `stray_number`.
4. **Literal words.** Every other word stays a literal word. Each must match
   `^[a-z0-9çğıöşü]+$` after folding (always true after `prepareText()`; the check
   guarantees no pattern metacharacter `{ } | * < > @` is ever stored). Patterns
   are stored as a token array and only joined for `compilePattern()`. A literal
   word that is a name or area word of the home (live context names, aliases,
   areas and every `direct.area_aliases` name) in any suffixed form — a stem
   match, or the word starting with a name word of 3+ letters with k/ğ, t/d, p/b
   folded ("odamızdaki", "mutfağımızdaki") — refuses the pattern
   (`name_word_in_pattern`). Only a `learning.keywords` device word and its
   inflected forms (plural, possessive, case, `-ki`: "lambası", "ışığını") are
   exempt; "lambaderin" is not. Refusing too much is the safe side.
5. **Round trip.** Compile the pattern and match it against the same prepared
   text with the learned-rule matcher; it must match and capture the same span
   and number. Otherwise drop (`round_trip`).

The dry-run in step 2 is the core idea: a pattern is only counted when the
existing executor, replayed on this utterance, **would have made exactly the call
the model made**. That is also the definition of a correct rule.

Example: "salon lambasını yüzde 40 yap" (number normalized), model call
`light__HassLightSet {name: "Salon Lambası", domain: ["light"], brightness: 40}`
→ tokens `[<ad>, yüzde, <sayi>, yap]`, tool `light__HassLightSet`, domains
`[light]`. The room and lamp names are not stored; "mutfak lambasını yüzde 70 yap"
is a second observation of the same pattern.

### "Same outcome"

An observation is the pair **(pattern, outcome signature)**:

```
signature = service + tool + target domain
            + argument binding (name ← <ad> or absent; numeric key ← <sayi> or absent)
```

The concrete entity and number are not part of the signature (that is what the
slots generalize); the answer text is not either. Per pattern the store keeps one
signature and a counter:

- same pattern, same signature → `observations + 1`;
- same pattern, different signature (once `light`, once `switch`; once TurnOn,
  once TurnOff) → the counter restarts at 1 with the new signature and
  `conflicts + 1`; at `conflicts ≥ 2` the pattern is `blocked` and never
  suggested (the phrasing is not predictable);
- `observations ≥ min_observations` (default 3) → status `candidate` (shows in the
  Development tab).

### Lifecycle

```
observing ──(N same outcomes)──▶ candidate ──"Kuralı ekle"──▶ active
    │                               │                          │
    └─(2 conflicts)─▶ blocked       └─"Yok say"─▶ rejected     │ K fallbacks in a row,
                                                               ▼ or no longer allowed
                                                           suspended ──▶ (decision 4)
```

- `rejected` and `blocked` entries keep pattern + signature only, so the same
  phrasing is not suggested again.
- **Suspension.** An `active` rule whose run ends in `fallback` (name not found,
  ambiguous, `isError`, live context error) `max_failures` times in a row (default
  3) becomes `suspended` with the last reason. A success resets the counter.
  Denials (declined confirmation, read-only, timeout of a confirmation), cancels
  and an unreachable service are neutral. Suspension writes a `rule_suspended`
  dev-note (badge, no push).
- **The fallback itself is silent**: the turn goes to tier 1 exactly like a static
  tier-0 fallback; the user hears the model's answer. Such a recovery turn is
  never an observation (`source` is not `default`).
- **No retry after an uncertain write.** The executor already answers an
  unreachable service (thrown call, timeout) with a reply and does not fall back,
  because the write may have happened; learned rules keep that.
- **Activation** is applied (snapshot swapped, `dev` answer sent) only after the
  new `rules.json` is on disk.

### Safety: allow list, default deny

Four independent layers; every one must allow. They are checked at learn time,
at activation, at every Core start (load) and at every run.

1. **Tool ceiling (code constant).** `LEARNABLE_TOOLS = intent__HassTurnOn,
   intent__HassTurnOff, light__HassLightSet` on service `home-assistant` (exact
   names; the tools `runDirectPlan()` can execute). Any other tool is not
   learnable, whatever router.yaml says.
2. **Domain ceiling (code constant).** `LEARNABLE_DOMAINS = light, switch,
   media_player` (light, brightness, plug, media on/off); `light__HassLightSet`
   only with `light`. A separate `NEVER_LEARNABLE_DOMAINS` constant is checked
   first, so a future edit of the ceiling cannot let these in: `lock,
   alarm_control_panel, cover, valve, garage_door, siren, climate, water_heater,
   camera, vacuum, lawn_mower, button, scene, script, automation`. `fan` is in the
   static tier-0 rules but not in the plan's low-risk list, so it is not learnable.
3. **Target check (domain alone is not enough: a `switch` can drive a door
   relay).**
   - `switch` targets are learnable only with positive evidence that they are a
     plug: `device_class: outlet` in the live context attributes. A switch
     without a device class is refused ([decision 7](#kullanıcı-kararı-gerekli-decisions-for-the-user)).
   - Any target whose `device_class` is in services.yaml `confirm_inputs.device_class`
     is refused.
   - Any target whose name, aliases or areas contain a word of
     `learning.deny_name_words` (generic Turkish vocabulary in router.yaml, e.g.
     `kapı, kilit, garaj, alarm, kepenk, panjur, vana`) is refused.
   - At run time the resolved entity is checked again (the executor gets the
     check as a resolution filter); a refused target falls back to the model.
4. **The gate itself.** At learn time the action must have been at level `write`.
   At run time the learned plan goes through `Session.authorize()` unchanged:
   services.yaml levels, `confirm_inputs` (the plan always passes
   `domain: [entity.domain]`), `CORE_READ_ONLY`, confirmation. If services.yaml
   later raises the tool to `confirm`, the learned rule asks like any tier-0 rule;
   approval of a rule never lowers a level (learned rules have no `permission`
   key).

router.yaml gets an optional `learning` block that can only narrow layers 1-3:

```yaml
learning:
  enabled: true            # off: nothing is observed and active rules are not used
  min_observations: 3
  max_failures: 3
  tools: [intent__HassTurnOn, intent__HassTurnOff, light__HassLightSet]   # ⊆ code ceiling
  domains: [light, switch, media_player]                                    # ⊆ code ceiling
  deny_name_words: [kapı, kilit, garaj, alarm, kepenk, panjur, vana]
  keywords:                # device words for <ad> resolution, per domain; single words, ≤ 64 chars
    light: [ışık, ışığı, ışıklar, ışıkları, lamba, lambası, lambalar, lambaları, aydınlatma]
  replies:
    intent__HassTurnOn: "Tamam, {ad} açıldı."
    intent__HassTurnOff: "Tamam, {ad} kapatıldı."
    light__HassLightSet: "Tamam, {ad} yüzde {seviye} yapıldı."
```

A value outside the ceiling is a startup error (zod), like other router.yaml
mistakes. The resolution options a rule was learned with (`domains`, `keywords`)
are stored in the rule, so a later router.yaml change cannot silently widen what
an active rule touches; a rule whose stored tool or domain is no longer allowed is
set to `suspended` (reason `not_allowed`) at load.

### Data file

`<SHADOW_DATA_DIR>/fast-path/rules.json`, written with `writeFileAtomic()`, read
with `readJsonOrQuarantine()` (a corrupt file or a `version` other than 1 is moved
aside; the Core starts with no learned rules and logs one warning; static tier 0
is unaffected). Read-modify-write serialized on one promise chain.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "lr-3f9a1c2e",
      "status": "candidate",
      "tokens": ["<ad>", "yüzde", "<sayi>", "yap"],
      "normalizer": 1,
      "service": "home-assistant",
      "tool": "light__HassLightSet",
      "domains": ["light"],
      "keywords": ["ışık", "lamba"],
      "binding": { "name": "ad", "brightness": "sayi" },
      "observations": 3,
      "conflicts": 0,
      "firstSeen": "2026-11-07T18:00:00.000Z",
      "lastSeen": "2026-11-08T07:30:00.000Z",
      "activatedAt": null,
      "activatedBy": null,
      "uses": 0,
      "consecutiveFailures": 0,
      "lastFailure": null
    }
  ]
}
```

- `id` = hash of tokens + signature (stable, so a repeated observation finds its
  entry).
- `normalizer` = the T7.w.1 normalizer version at learn time. On a mismatch,
  `observing` counts restart (they were counted under another normalization);
  `active` rules stay, since their round trip is re-checked by the next
  observation of the same phrasing.
- `activatedBy` is the device name from the token (never the token).
- Caps: at most 200 `observing` entries (least recently seen dropped first) and
  200 `rejected` / `blocked`; `candidate`, `active` and `suspended` are never
  dropped.
- The file holds the literal words of the user's phrasings, never room or device
  names (they are slots), arguments, results or tokens. It stays in the data dir
  (backed up with it), is not logged, and is not in `/health`.

### Components

| Unit | Kind | Responsibility |
|---|---|---|
| `core/src/learn/extract.ts` (new) | pure | eligibility, steps 1-5, safety layers 1-3, signature; returns tokens or a reject reason |
| `core/src/learn/store.ts` (new) | I/O | `rules.json`, lifecycle, counters, caps, load-time re-validation, active snapshot |
| `router-config.ts` | pure | `learning` schema and ceilings; compile learned rules with `compilePattern()`; matcher shared with static rules |
| `router.ts` | pure | `TieredRouter` tries the active snapshot after static rules; `RouteDecision.source` |
| `direct.ts` | pure | optional target filter (safety layer 3) in `resolveWithAliases()`; used only by learned plans |
| `session.ts` | wiring | per-turn gated-call capture; observation at settle; learned-rule outcome reporting |

### Tests

- `extract.ts` table tests (no I/O): number slot, stray number, number not in text,
  a device name with a digit ("Lamba 2") and a brightness, name span found / not
  found / ambiguous, area-only call, an unexplained argument, a stop name, each
  never-learnable domain, a deny word, a `switch` with no device class, with
  `outlet`, with `door`, round trip, metacharacters never stored.
- Store tests (temp dir, injected clock): N observations → candidate, conflict
  reset and block, reject keeps blocking, failure counting and suspension, neutral
  outcomes, success reset, caps, normalizer change, corrupt file quarantined,
  unknown version, activation visible only after the write.
- Router tests: a static rule (any tier) always wins over a learned rule; learned
  rules never match when `learning.enabled: false`, `direct.enabled: false`,
  `CORE_ROUTER=off` or the rule is not `active`; `TIER0_MAX_CHARS`.
- Session tests (fake direct client, fake model turn): one eligible turn makes one
  observation; a confirm-level call, two action calls, an `isError` result, a
  static tier-0 fallback turn, an escalated turn with two action calls and a
  cancelled turn make none; a learned rule goes through `authorize()` (a
  `confirm_inputs` hit asks; read-only denies, no fallback); a learned-rule
  fallback reaches tier 1 silently and counts one failure; three in a row suspend.
- Existing `router-matcher.test.ts`, `router-tier0.test.ts`, `tiers.test.ts` pass
  unchanged (the static fast path is untouched).

## T7.w.3 Turn dev-notes

### Decision

Keep `tools.json` exactly as it is (its writer is the MCP gateway) and add a second
file next to it, `<SHADOW_DATA_DIR>/dev-notes/turns.json` (version 1), written by
the session and the gateway's call path. The counting logic of `DevNotes.apply()`
(find by key, bump `count` / `lastSeen`, cap, atomic write) moves into one small
shared helper used by both files. Rule suggestions are **not** copied into
dev-notes: the learned-rule store is their source of truth, and the Development
tab lists both (T7.w.4).

Alternative: one file for everything (`tools.json` version 2). Rejected: two
writers on one file, a schema migration, and nothing gained.

### Kinds (`turns.json`)

| Kind | Recorded when | Key (one note per key) |
|---|---|---|
| `missing_capability` | the model asked for something the Core cannot give: a built-in tool (gate `builtin`), a tool outside the tier's services (`tier_service`), a tool name the gateway does not list (`unknown_tool`, recorded in `McpGateway.call()`, before the gate) | kind + reason + service + tool |
| `wandering` | a model turn with ≥ `wander_calls` tool calls (default 5; `DEFAULT_WANDER_CALLS` in session.ts, not a router.yaml key in v1) or stopped by the tool-call cap (`tool_cap`, persistent sessions) | kind + tier + route source/rule + sorted unique tool names (max 5) |
| `tool_error` | a tool result with `isError`, or the service unreachable (model or tier 0); user denials are not errors | kind + service + tool + class (`error` / `unavailable`) |
| `rule_suspended` | a learned rule was suspended | kind + rule id + reason |

Each note: key fields, a short Turkish `message`, `count`, `firstSeen`,
`lastSeen`, `lastTurnId`, and the Development-tab state `status?` (`ignored` /
`fixed`; absent = open) with `statusAt`.

- **Where each kind is recorded (T7.w.3b):** `builtin` and `tier_service` in the
  session gate. In production the SDK guard (`gatewayToolGuard`, gateway-sdk.ts)
  denies every non-gateway name before the Core gate sees it, so a `builtin` note
  only appears for a built-in name that reaches the gate; recording the guard's
  denials needs gateway-sdk.ts / agent.ts and a turn id there (not in T7.w.3b).
  `unknown_tool` in `McpGateway.call()`, which serves no particular turn, so these
  notes have **no `lastTurnId`**. `wandering` counts the model calls that reached
  the Core gate (calls refused before it, by the SDK guard or as `unknown_tool`,
  are not counted). `tool_error` in the session: at tier 0 with both classes, on
  the model path for an `isError` result of a call the gate allowed, always class
  `error` (the session sees only `isError`, so an unreachable service, an approval
  that came too late for the call's time limit or a call of an ended turn are not
  told apart); a denied call (user, timeout, read-only, tier) and the error result
  of a cancelled turn are not errors. `rule_suspended` when a run suspends a learned
  rule (a load-time suspension by router.yaml is only logged).
- **Privacy rule (same as `tools.json`, enforced by a test):** only enum values,
  tool and service names from the catalog, tier, route source / static rule id,
  learned rule id, counts, times and the opaque `lastTurnId`. Never user text,
  arguments, results, entity or room names, error messages, URLs or tokens.
  `lastTurnId` points into the local conversation log, which already holds the
  text, so the developer can look the turn up without the note copying it.
- Every occurrence counts (the one-hour `touchMs` stays for `tools.json`, where the
  same list is seen every minute). These events are rare; writes are coalesced
  (at most one per few seconds, flushed on shutdown). Cap 500 notes, least
  recently seen dropped.
- A `fixed` note observed again after `statusAt` is open again (badge). An
  `ignored` note keeps counting but never badges.
- "Missing capability" from the model's own words ("bunu yapamıyorum") is not
  detected in v1 (it needs a prompt marker; [decision 6](#kullanıcı-kararı-gerekli-decisions-for-the-user)).

`tools.json` notes get the same optional `status` / `statusAt` fields (additive;
`validateFile()` keeps the note objects as they are; the version stays 1), so the
tab can ignore or close them too.

## T7.w.4 Development tab (UI) and tray

### Protocol (additive, protocol stays 1)

Behind a new feature flag `dev` in `welcome.features`, mirroring the memory frames:

| Direction | Frame | Fields |
|---|---|---|
| client → Core | `dev_list` | `id` |
| client → Core | `dev_action` | `id`, `itemId`, `action`: `add_rule` \| `ignore` \| `fixed` |
| Core → client | `dev` | `id` (request id), `items[]`, `open` (badge count), `canManage` |
| Core → all authenticated sockets | `dev_count` | `open` (sent when it changes; clients do not announce features, so a client that does not know the frame ignores it) |

`items[]`: `{ itemId, type: "rule" | "note", kind, status, message, count,
firstSeen, lastSeen, rule?: { tokens, tool, domains, numberRange?, observations } }`.
Display only; it carries the fields of the files, nothing more. Errors:
`unknown_item`, `not_allowed` (action not valid for the item, or the device may
not do it), `bad_request` (malformed frame; the existing code, no new `bad_frame`). Actions are idempotent (`add_rule` on an active rule is a
no-op answered with the fresh list).

| Action | Rule candidate | Suspended rule | Note |
|---|---|---|---|
| `add_rule` ("Kuralı ekle") | → `active` (re-validated first) | – ([decision 4](#kullanıcı-kararı-gerekli-decisions-for-the-user)) | – |
| `ignore` ("Yok say") | → `rejected` | → `rejected` (`LearnedRuleStore.reject()` takes candidates and suspended rules, never active ones) | `status: ignored` |
| `fixed` ("Düzeltildi") | – | – | `status: fixed` (does not change rules or services.yaml) |

Badge count `open` = candidates + suspended rules + open notes.

### Authorization

All Development frames come over an authenticated socket, so the Core knows the
device name from the token (never from `hello.client`).

- Listing, `ignore` and `fixed`: every authenticated device (they cannot change
  how the home is controlled).
- `add_rule` changes how the home is controlled, so it is limited to the devices
  in `CORE_DEV_DEVICES` (comma-separated device names). **Unset = nobody**
  (fail closed; the tab shows a short hint), [decision 3](#kullanıcı-kararı-gerekli-decisions-for-the-user).
  `dev.canManage` tells the UI whether to show the button. The activating device
  is stored in `activatedBy` and logged.
- No new HTTP route for the UI.

### UI

A "Geliştirme" panel next to `MemoryPanel` (`ui/src/ui/DevPanel.tsx`, `Drawer`
pattern), opened from Settings and from a badge, shown only when `dev` is in
`features`. Rule candidates first: the pattern with slots as "‹cihaz›" / "‹sayı›",
the action as a Turkish label ("parlaklık ayarla"), the domains, the number range
and the observation count, so the user sees how far the rule generalizes before
pressing "Kuralı ekle". Then notes by kind with their count. No sound, no
`adapter.notify`. `App.tsx` opens the panel for the URL hash `#dev` (used by the
tray).

### Tray

The tray stays a menu and gets no token for this (it reads only non-secret `.env`
keys today). Narrowest form:

- `GET /health` adds `inbox: { dev: <open>, notifications: <unread> }` **only for
  loopback requests** (`req.socket.remoteAddress` `127.0.0.1` / `::1`). Two
  numbers, no titles or contents. Remote callers see the same body as today.
- `CoreHealth.cs` parses `inbox`; `TrayApp.cs` shows menu items "Geliştirme (N)"
  and "Bildirimler (M)" that open the UI at `#dev` / `#notifications`, and a dot
  on the icon while `notifications > 0` (`TrayIcons.cs`). Development counts never
  show a balloon; a rise in the unread notification count shows one balloon
  "N yeni bildirim" (no titles; [decision 5](#kullanıcı-kararı-gerekli-decisions-for-the-user)).
- Actions happen in the UI, which has a device token.

Alternative: an authenticated `GET /development` for a tray with its own token,
or a native tray window. Both need a secret in the tray and more C# code for no
new capability; left to decision 5.

## T7.w.5 Notification store

### Decision

One Core store, `<SHADOW_DATA_DIR>/notifications/notifications.json` (version 1,
`writeFileAtomic()`, quarantine on corruption), with a small producer API inside
the Core and list/update frames for clients. No producer is required by T7.w; the
store is built and tested with a test producer. Later producers (backup, service
health, HA events, T11-B) only call the API. Development items are not
notifications (no push, no sound) and stay in their own stores.

### Item

```json
{
  "id": "n-8c2d…",
  "key": "service-down:tts-svc",
  "source": "service",
  "urgency": "normal",
  "title": "Ses servisi yanıt vermiyor",
  "body": "…",
  "createdAt": "…",
  "updatedAt": "…",
  "readAt": null,
  "raised": 1
}
```

- `source`: a short fixed string per producer (`service`, `backup`, `ha`,
  `device-state`, `test`), for filtering and so a producer finds its own items.
- `urgency`: `normal` (inbox, tray count, phone notification without sound) or
  `urgent` (also spoken once, phone notification on a high-importance channel).
- `key` (optional, unique per `source`): dedupe key. `raise({ source, key, … })` on
  an existing key **replaces** title/body/urgency and bumps `updatedAt` and
  `raised`; it becomes unread again only when the producer asks (`renotify:
  true`, e.g. a new reminder time). Without a key every raise is a new item.
- `resolve(source, key)`: the producer removes its item (the condition is over).
- The user: mark read / unread, delete. One shared inbox for the home: `readAt` is
  shared across devices.
- **Kept until deleted or resolved; no silent pruning.** A hard limit (5000 items)
  only refuses new keyless raises (logged); recurring conditions must use a key.

**T11-B fit (not designed here):** the reminder is one keyed item
(`source: "device-state"`, `key: "case-battery-low"`, `urgency: "normal"`). At
22:00 / 23:00 / 00:00 the producer raises it with `renotify: true` while the last
reading is below the threshold and the user has not acknowledged it since that
reading; "şarja taktım" is the user marking it read (`readAt` later than the last
low reading = acknowledged until the next low reading); a reading ≥ threshold
resolves it. No field beyond the above is needed.

### Delivery

- **Core → clients.** Feature flag `notifications`. Client frames
  `notifications_list {id}` and `notification_action {id, notificationId, action:
  read | unread | delete}`; Core frames `notifications {id, items, unread}` and,
  broadcast to every authenticated socket, `notification {item}` (new or updated)
  and `notification_removed {notificationId}`.
- **UI inbox.** A "Bildirimler" panel with a badge; `#notifications` hash for the
  tray. Being spoken never marks an item read.
- **Urgent = spoken, once, on one device.** At raise time the Core sends a
  `speak: true` flag on the `notification` frame to one session only: the
  connected session with speech enabled whose device had the most recent turn.
  That client speaks title + body through the existing speech path. A reconnect
  never speaks an old urgent item again.
- **Phone, narrowest form without a new dependency.** While the Android app is
  connected, the UI gets the `notification` frame and calls `adapter.notify()`
  when not visible; on connect, unread items not yet shown on this phone (ids kept
  in the WebView's local storage) are shown once. `Notifier.kt` gets a
  "Bildirimler" channel (default importance, no sound) and an urgent channel next
  to the confirmation channel, and a per-item notification id derived from the
  item id (today every call replaces id 1). Dismissing the system notification
  does not delete the item. This is **not** push: a phone whose app is closed sees
  the items when it next connects.
- **Real push** (app closed) needs one of: FCM (new external dependency, Firebase
  project, Google services on the phone), a periodic WorkManager poll of an
  authenticated `GET /notifications` on the pattern of the T11 worker (no external
  dependency, a second background exception, delay of 15 min or more, never
  "urgent"), or a foreground service with its own connection (breaks the "no
  background listening" rule). [Decision 1](#kullanıcı-kararı-gerekli-decisions-for-the-user);
  T11-B depends on it.

## T7.w.6 Built-in tools closed

Most of this exists and passes today:

- `core/test/agent.test.ts` "buildOptions locks the model down to MCP tools only";
- `core/test/gateway-sdk.test.ts` "built-in Claude Code tools are closed in every
  model query (legacy and persistent)": `tools: []`, no `allowedTools`,
  `settingSources: []`, `strictMcpConfig`, `permissionMode: "default"`, the
  `disallowedTools` list, only gateway servers, `canUseTool` denies every name in
  `DENIED_BUILTIN_TOOLS`;
- the same file, "guard: gateway tools pass to the Core gate; built-in and foreign
  tools are denied".

Gaps, closed by T7.w.6a (unit level, no SDK process):

1. **One-shot options.** `buildOneShotOptions()` (`one-shot.ts`, moved out of index.ts; memory extraction and
   lifecycle summaries) has no test: assert `tools: []`, `mcpServers: {}`,
   `disallowedTools`, `settingSources: []`, `strictMcpConfig`, `maxTurns: 1`,
   `persistSession: false`, and that its `canUseTool` denies any name.
2. **Names the list does not know.** Assert that `gatewayToolGuard()` and
   `Session.authorize()` (via `PermissionPolicy.levelFor`) deny an unknown non-`mcp__`
   name (e.g. `FutureTool`), so a built-in added by a later SDK version is closed
   even before `DENIED_BUILTIN_TOOLS` lists it.

A prompt-based check ("read this file") is not proof of a security boundary and
is not part of the task; a manual check after an SDK upgrade is optional.

## T7.w.7 Contextual commands: deferred

**Decision: not implemented now (ERTELENSİN).**

- **The model already covers it.** In persistent sessions the model sees the
  conversation, and tier-0 exchanges reach it through `addDirectNote()`, so "yüzde
  elli yap" after "salon lambasını aç" goes to tier 1 and is resolved from context
  (about 2 s). docs/04 leaves nameless commands to the model on purpose. A fast
  path would save about 2 s on a rare phrasing.
- **The risk has nothing to check it against.** Which device "it" means depends
  on timing, on what the last turn touched (it may have been a cover or a device
  the model, not tier 0, handled), on another person using the same device (one
  conversation per device token, several sockets share it), and on a voice
  transcript that dropped the device name. The learned rules are safe because the
  device name is in the utterance and checked against HA; a contextual command has
  no such anchor. The learner never produces one (extraction step 2 rejects calls
  whose target is not in the text).
- **Cost.** A second state machine (per-session referent, expiry, invalidation)
  before the learned rules have been used in practice.

If it is picked up later, the minimum limits: only `light__HassLightSet` and on/off
in the `light` domain; the referent only from a successful tier-0 or learned call
in the same device session within 2 min, in memory only; one entity, never an
area; cleared by any model turn, any failure or denial, a disconnect, or another
target; never across domains; every use resolves the entity again and goes through
the same gate; the answer names the device ("Salon lambası yüzde 50"); no rule is
ever learned from such a turn.

## Failure modes

| Failure | Behaviour |
|---|---|
| `rules.json` corrupt / unknown version | quarantined, no learned rules, one warning; static tier 0 unaffected |
| live context unreadable during learning | observation dropped silently |
| learned rule cannot resolve the name, or `isError` | silent fallback to tier 1, failure counted, suspension after K |
| learned rule: service unreachable / timeout | short reply, no fallback (the write may have happened); neutral for suspension, `tool_error` note |
| services.yaml raises the tool to `confirm` | the learned rule asks for confirmation (gate) |
| router.yaml narrows `learning` | affected rules `suspended` (`not_allowed`) at load |
| a store write fails | logged; in-memory state kept; next write retries; a rule activation is not applied |
| a client that does not know `dev` / `notifications` | it ignores the broadcast count frames (they go to every authenticated socket; clients do not announce features); request frames are only sent by clients that saw the feature; badges hidden without the feature |

## Kullanıcı kararı gerekli (decisions for the user)

Each item has a default so that implementation can go ahead where it does not
block.

1. **Phone push when the app is closed** (blocks T11-B, not T7.w): FCM (new
   external dependency), a WorkManager poll (no dependency, ≥ 15 min delay, a
   second background exception), or none. Default for T7.w: none; notifications
   reach the phone while the app is connected and on the next connect.
2. **New protocol frames** (`dev*`, `notification*`, `welcome.features` `dev` /
   `notifications`) and the loopback-only `inbox` field in `/health`: additive,
   protocol stays 1, docs/02 updated. Default: accept.
3. **Who may press "Kuralı ekle":** default fail closed, only devices listed in
   `CORE_DEV_DEVICES`. Alternative: every authenticated device when unset.
4. **Removing or re-activating a learned rule from the tab.** The plan names only
   "Kuralı ekle / Yok say / Düzeltildi". Without a "Kaldır" action an active rule
   can only be removed by editing `rules.json`, and a suspended rule cannot come
   back. Recommended: add `remove_rule` (active → rejected) and allow `add_rule` on
   suspended rules (same device limit). Default until decided: not built.
5. **Notification titles in the tray** (balloon text) or a native tray tab would
   need a token for the tray. Default: counts only.
6. **"Missing capability" from the model's answer** through a prompt marker (like
   `[[ESCALATE]]`): more useful notes, more prompt and output tokens. Default: not
   in v1.
7. **Plugs without a device class.** Default: a `switch` is learnable only with
   `device_class: outlet` (some plugs may then never be learned). Alternative:
   accept switches without a device class, relying on the deny words and the gate.
8. **Learning on by default** (`learning.enabled: true`): observing costs one live
   context read after each eligible model turn; nothing becomes active without
   approval. Default: on.

## Out of scope and deferred

- T7.w.7 contextual commands (above).
- Media beyond on/off (pause, volume, next): needs services.yaml levels for the HA
  media tools (unlisted HA tools are `confirm` today), their real names and
  schemas from HA's tool list (only a test fixture has `media__HassMediaPause`),
  and a typed executor step per tool; relative volume and next-track stay out.
- Phone push with the app closed (decision 1) and the T11-B reminder.
- Producers for the notification store (backup errors, service down, HA events).
- Generalizing learned patterns to word groups; learning multi-call or area-wide
  turns.

## Related findings (not part of the plan; need approval)

- The static tier-0 rules `light-on/off` and `device-on/off` accept `switch` (and
  `fan`) targets with no device-class or name check; a `switch` that drives a door
  relay is only caught if HA does not expose it. The learned rules add such a
  check (layer 3); the static ones could use the same filter.
- Tier-0 fallbacks with `name_not_found` point at missing HA aliases. A
  `tier0_fallback` dev-note kind would surface them; it is not in T7.w.3's list.
- `Notifier.kt` uses one fixed notification id, so a second confirmation request
  replaces the first; T7.w.5d changes the id scheme for notifications only.

## Implementation tasks

Boxes: `[ ]` not started, `[~]` started, `[x]` done. **Files** lists everything a
task may touch. Two tasks that share a file are never run in parallel; the
**After** column enforces this. **Data** marks tasks that write persistent data.

| Task | Files | After | Data |
|---|---|---|---|
| T7.w.2a | `core/src/router-config.ts`, `router.yaml`, `core/test/router-matcher.test.ts`, `docs/04-router.md` | T7.w.1 | – |
| T7.w.2b | `core/src/learn/extract.ts` (new), `core/src/direct.ts`, `core/test/learn-extract.test.ts` (new) | 2a | – |
| T7.w.2c | `core/src/learn/store.ts` (new), `core/test/learn-store.test.ts` (new) | 2a | `fast-path/rules.json` |
| T7.w.2d | `core/src/router.ts`, `core/src/session.ts`, `core/src/index.ts`, `core/test/tiers.test.ts`, `core/test/session-learn.test.ts` (new) | 2b, 2c, T7.w.1 | `fast-path/rules.json` |
| T7.w.3a | `core/src/dev-notes.ts`, `core/test/dev-notes.test.ts` | – | `dev-notes/turns.json` |
| T7.w.3b | `core/src/session.ts`, `core/src/mcp-gateway.ts`, `core/test/session-devnotes.test.ts` (new) | 3a, 2d | `dev-notes/turns.json` |
| T7.w.4a | `core/src/protocol.ts`, `core/test/protocol.test.ts`, `ui/src/protocol/types.ts`, `ui/src/protocol/protocol.test.ts`, `docs/02-core-protocol.md` | – | – |
| T7.w.4b | `core/src/session.ts`, `core/src/server.ts`, `core/src/config.ts`, `core/src/index.ts`, `.env.example`, `core/test/session-dev.test.ts` (new), `core/test/health.test.ts` | 4a, 2d, 3b | rules + notes (status) |
| T7.w.4c | `ui/src/ui/DevPanel.tsx` (new), `ui/src/App.tsx`, `ui/src/ui/Panels.tsx`, `ui/src/ui/strings.ts`, `ui/src/assistant/controller.ts`, `ui/src/assistant/*.test.ts` | 4a | – |
| T7.w.5a | `core/src/notifications.ts` (new), `core/test/notifications.test.ts` (new) | – | `notifications/notifications.json` |
| T7.w.5b | `core/src/protocol.ts`, `core/src/session.ts`, `core/src/server.ts`, `core/src/index.ts`, `docs/02-core-protocol.md`, `core/test/protocol.test.ts`, `core/test/session-notifications.test.ts` (new) | 5a, 4a, 4b | – |
| T7.w.5c | `ui/src/ui/NotificationsPanel.tsx` (new), `ui/src/App.tsx`, `ui/src/assistant/controller.ts`, `ui/src/protocol/types.ts`, `ui/src/platform/*.ts`, `ui/src/ui/strings.ts`, `ui/src/assistant/*.test.ts` | 5b, 4c | – |
| T7.w.5d | `android/app/src/main/java/app/shadowassistant/android/Notifier.kt`, `.../MainActivity.kt` (bridge), `android/app/src/main/res/values/strings.xml` | 5c | – |
| T7.w.4d | `deploy/windows/tray/src/ShadowTray/CoreHealth.cs`, `TrayApp.cs`, `TrayIcons.cs`, tray tests | 4b, 5b | – |
| T7.w.6a | `core/test/agent.test.ts`, `core/test/gateway-sdk.test.ts`, `core/test/permissions.test.ts` | – | – |

Parallel lanes: {3a, 4a, 5a, 6a} can start at once; 2a starts when T7.w.1 has
landed (both touch the router). 2b and 2c run in parallel after 2a. 4c runs in
parallel with the Core work after 4a. `session.ts` serializes 2d → 3b → 4b → 5b;
`App.tsx` serializes 4c → 5c; 4d waits for both `/health` changes (4b, 5b).
T7.w.7 has no task (deferred).

- [x] **T7.w.2a — `learning` config and ceilings.** zod schema for the `learning`
  block; `LEARNABLE_TOOLS` / `LEARNABLE_DOMAINS` / `NEVER_LEARNABLE_DOMAINS`;
  narrowing check; a compile function for learned token arrays on top of
  `compilePattern()`, sharing the matcher with static rules; the router.yaml block
  with generic words only; a docs/04 section. Acceptance: a value outside the
  ceiling fails startup with a clear message; a learned pattern compiles and
  matches like the equivalent static one; all existing router tests pass.
- [x] **T7.w.2b — Extractor.** Eligibility, steps 1-5, safety layers 1-3, signature,
  reject reasons; the target filter in `direct.ts`. Acceptance: the extractor
  tests in [Tests](#tests) pass; it never returns a pattern for a never-learnable
  domain, a deny word, a `device_class` from `confirm_inputs`, a switch without
  `outlet`, an area-only call, a call whose target is not in the text, or a
  confirm-level call.
- [x] **T7.w.2c — Rule store.** `rules.json` with lifecycle, counters, caps,
  quarantine, normalizer version, load-time re-validation, active snapshot.
  Acceptance: the store tests in [Tests](#tests); a write interrupted before the
  rename leaves the previous file intact.
- [x] **T7.w.2d — Router and session wiring.** `RouteDecision.source`; learned rules
  after static rules; per-turn gated-call capture across attempts; observation at
  settle, off the turn path; learned-rule outcome reporting and suspension.
  Acceptance: the router and session tests in [Tests](#tests); a static tier-0
  command still runs without a model and without added latency; three eligible
  turns of one phrasing produce one candidate and no active rule.
- [x] **T7.w.3a — Shared counted-notes helper and `turns.json`.** Move the
  observe/cap/write logic out of `DevNotes`; `tools.json` behaviour unchanged;
  optional `status` / `statusAt`; coalesced writes. Acceptance: existing
  `dev-notes.test.ts` passes unchanged; tests for each `turns.json` kind and for
  reopen-after-fixed; a privacy test feeds secret-looking arguments, text, entity
  names and error messages and asserts none of them reach either file.
- [x] **T7.w.3b — Recording turn notes.** `missing_capability` (gate and
  `McpGateway.call()`), `wandering`, `tool_error`, `rule_suspended`. Acceptance:
  session/gateway tests for each kind; `lastTurnId` set; a user denial is not a
  `tool_error`.
- [x] **T7.w.4a — Protocol: dev frames.** Types, parsing, `dev` feature, docs/02.
  Acceptance: parser tests (valid, invalid, unknown fields ignored); old frames
  unchanged.
- [x] **T7.w.4b — Core: Development listing and actions.** `dev_list`, `dev_action`,
  `dev_count` broadcast, `CORE_DEV_DEVICES` (+ `.env.example`), loopback-only
  `inbox.dev` in `/health`. Acceptance: `add_rule` from a listed device activates
  a candidate (re-validated) and the next matching utterance runs at tier 0;
  `add_rule` with `CORE_DEV_DEVICES` unset or from another device → `not_allowed`;
  `/health` from a non-loopback address has no `inbox`.
- [x] **T7.w.4c — UI Development panel.** As in [UI](#ui). Acceptance: controller
  tests for list, actions, badge and `canManage`; panel hidden without the `dev`
  feature; no `notify` or sound for development items.
- [x] **T7.w.4d — Tray counts.** As in [Tray](#tray). Acceptance: tray tests parse
  `inbox` (present, absent, malformed); menu items open `#dev` / `#notifications`;
  no balloon for development counts; no token read from `.env`.
- [x] **T7.w.5a — Notification store.** `raise` (with `key`, `renotify`),
  `resolve(source, key)`, `markRead` / `markUnread`, `delete`, `list`, the hard
  limit, quarantine. Acceptance: unit tests including the T11-B sequence (raise,
  renotify, read as acknowledgement, resolve) with a fake clock; items survive a
  restart; nothing is pruned silently.
- [x] **T7.w.5b — Notification frames.** `notifications` feature, list/action frames,
  `notification` / `notification_removed` broadcast, urgent `speak` to one
  session, loopback `inbox.notifications`. Acceptance: session tests for list,
  read, delete, a broadcast reaching two sockets, an urgent item spoken by one
  session only and not again after a reconnect; docs/02 updated.
- [x] **T7.w.5c — UI inbox.** Panel, badge, `#notifications`, urgent speech, phone
  `notify` for new items and for unread items not yet shown. Acceptance:
  controller tests (badge, read/delete, urgent spoken once, catch-up shows each
  item once).
- [x] **T7.w.5d — Android channels.** Notifications channel (no sound), urgent
  channel, per-item ids. Acceptance: manual on a phone: a test item appears while
  the app is in the background; two items show as two notifications; a
  confirmation still uses its own channel; dismissing does not delete the item.
- [x] **T7.w.6a — Built-in tools test gaps.** The two additions in
  [T7.w.6](#t7w6-built-in-tools-closed). Acceptance: the tests fail if `tools`,
  `mcpServers`, `settingSources` or the guard of `buildOneShotOptions()` is
  loosened, or if an unknown non-`mcp__` name is allowed.

## Progress log

- 2026-11-07: design written (software-architect, after a Codex review of the
  same code). T7.w.1 in progress separately.
- 2026-11-07: T7.w.3a, T7.w.4a, T7.w.5a done (senior-code-reviewer 2 rounds, tester
  with mutation checks). T7.w.4a: malformed `dev_action` answers the existing
  `bad_request` (not a new `bad_frame`); `ui/src/assistant/state.ts` got no-op
  cases for `dev` / `dev_count` so the exhaustive reducer builds. T7.w.6a gap 2
  (unknown non-`mcp__` names) done; gap 1 blocked: `buildOneShotOptions()` lives
  in `index.ts`, which runs `main()` on import, so it cannot be tested without a
  source change (move it to its own module) — awaiting a decision.
- 2026-11-07: T7.w.2a done (senior-dev): `learning` block + ceilings in router-config.ts,
  shared capture for static and learned patterns, router.yaml block, docs/04 section.
  Narrowest readings: router.yaml `deny_name_words` is added to a code base list
  (`BASE_DENY_NAME_WORDS`), never replaces it; the normalizer version is
  `TEXT_NORMALIZER_VERSION` in router-config.ts (numbers.ts is outside the 2a-2d files).
- 2026-11-07: T7.w.2b done (senior-dev): `learn/extract.ts` (eligibility, steps 1-5,
  layers 1-3, signature) and the `targetFilter` in direct.ts (`resolvePlanTarget`,
  `directCallArgs`). Narrowest readings: the model's call must carry exactly one
  `domain` (the executor always passes one) and a `name`; a name span counts only
  if steps 3-5 also succeed for it (so "Lamba 2" + a brightness is learnable).
- 2026-11-07: T7.w.2c done (senior-dev): `learn/store.ts` (`observe`, `activate` = the
  candidate → active step for T7.w.4b, `reject`, `recordOutcome`, `list`, snapshot).
  Readings: a candidate whose normalizer differs at load goes back to observing (0);
  activation is a copy-write-swap, suspension applies in memory even if its write fails.
- 2026-11-07: T7.w.2d implemented (senior-dev): `RouteDecision.source` / `learnedId` / `text`,
  learned rules after static ones, per-turn gated-call capture (paired by tool use id),
  observation after every attempt settled, learned-rule outcomes and suspension; index.ts wiring.
  Review round 1 (senior-code-reviewer): fixed — a literal pattern word that is a name or
  area word of the home is refused (`name_word_in_pattern`; else a room name could land in
  rules.json); deny words match as a substring and the base list got English words; an
  unpairable tool result is logged once. Kept by choice: a normalizer change also resets
  `conflicts` of observing / candidate entries (they were counted on other text); built-in
  tool attempts the SDK guard denies before the Core gate are not seen by the learner (the
  learned action is still the one allowed call).
- 2026-11-07: Review round 2 (senior-code-reviewer) left findings open; stopped after two rounds
  for a decision. 2b back to [~]: a home name word can still reach rules.json as a literal
  (keyword-prefix exemption "lambader", compound/softened suffixes "odamızdaki"/"mutfağımızdaki",
  names only in `direct.area_aliases`). 2a back to [~]: `learning.keywords` accepts words with
  spaces / > 64 chars that the rules.json validator rejects (the whole file would be quarantined
  at the next start). 2d acceptance met (router + session tests); tester not run yet.
- 2026-11-07: Review round 3 (targeted, last; senior-dev fix, senior-code-reviewer, tester with
  mutation checks). Closed: device-word exemption only for a `keywords` word plus an inflection
  suffix (`DEVICE_WORD_SUFFIX`, "lambaderin" refused); name words compared by stem or 3+ letter
  prefix with k/ğ, t/d, p/b folded ("odamızdaki", "mutfağımızdaki"); `direct.area_aliases` names
  are name words; `learning.keywords` uses the rules.json rule (`LEARNED_KEYWORD`, single word
  ≤ 64 chars) and fails startup otherwise. 2a [x]. 2b stays [~]: one low residual awaits a
  decision — a real word that is a keyword plus a valid suffix ("prizma", "lambada") is still
  exempt even when it is a home name. npm test 1139/1139, lint, build clean.
- 2026-11-07: known residual after the third (last) review round, left open for
  a user decision: the device-word exemption runs before the name-word check, so
  a real word that is a device word plus a valid suffix ("prizma", "lambada")
  can still be stored as a literal even when it is also a home name. Option:
  check name words first (blocks more phrasings, e.g. "lambası" when a device is
  called "Tavan Lambası").
- 2026-11-07: T7.w.3b, T7.w.4b and the rest of T7.w.6a implemented (senior-dev); review
  and tester pending. Narrowest readings: `unknown_tool` notes come from the gateway and
  have no `lastTurnId` (it serves no turn; giving it one needs device-agent.ts /
  gateway-sdk.ts); model-path `tool_error` is always class `error`; `wander_calls` is a
  code default (5), not a router.yaml key; `bad_request` stays the malformed-frame code
  (docs/08 aligned); `dev_count` goes to every authenticated socket (docs/08 aligned with
  docs/02); `ignore` on a suspended rule answers `not_allowed` (the store rejects
  candidates only; store.ts is outside the 4b files); loopback for `/health` `inbox` also
  accepts `::ffff:127.0.0.1`. `buildOneShotOptions()` moved unchanged to `one-shot.ts`.
- 2026-11-07: T7.w.3b, T7.w.4b, T7.w.6a done (senior-code-reviewer 2 rounds, no critical or
  high finding; tester: core 1165/1165, lint, build, ui 336/336, 11 mutations killed).
  Round 1 fixed: an approving device name the rule file cannot store gets its own
  `not_allowed` message; the narrow readings for `builtin` (the SDK guard denies first),
  `wandering` (calls that reached the gate) and model-path `tool_error` are written in
  §T7.w.3. Open, for a decision: a suspended rule counts in `open` but no tab action can
  clear it (the UI offers "Yok say", the Core answers `not_allowed`) until decision 4 or a
  `reject()` for suspended rules in store.ts.
- 2026-11-07: T7.w.5b done (senior-dev; senior-code-reviewer 2 rounds, no critical or high
  finding; tester: core 1183/1183, ui 356/356, lint, build, 9 of 10 mutations killed, the
  10th an equivalent mutant). `NotificationCenter`
  in session.ts (beside `DevelopmentTab`): each session attaches itself for the broadcasts and
  reports its turns. Narrowest readings: `speak` on an urgent raise that is new or has
  `renotify` (a keyed update without it is not spoken again); the speaker is the socket with
  speech on (`speech_prefs` enabled) whose device had the latest turn, ties by that socket's
  own latest turn, then the newest socket; no such socket → nothing spoken. Frames carry the
  stored fields without the producer's `key`. `read` / `unread` idempotent without a
  broadcast; `delete` of a missing item → `unknown_item`. `NotificationCenter.flush()` runs in
  the shutdown chain. UI: frame types and parser only (`ui/src/protocol/types.ts`), no-op
  reducer cases in `ui/src/assistant/state.ts`. Also O1: `LearnedRuleStore.reject()` takes
  suspended rules too, so "Yok say" on a suspended rule rejects it and the badge drops; the
  open item above (suspended rule cannot be cleared) is closed. Active → rejected and
  re-activation stay out (decision 4).
  Review round 1 fixed: `NotificationCenter.flush()` on the center's chain in the shutdown
  chain; tie-breaker and closed-socket speaker tests; docs/02 states that an unreadable
  notifications file reads as an empty inbox / `unknown_item`. Left open (related findings): the
  store does not report `unavailable` to list/actions; `delete` of a missing item is
  `unknown_item` (5c should ignore it after a `notification_removed`); every action clones the
  list (needs a store API change); no server-level test of welcome-before-broadcast and the
  index.ts wiring.
- 2026-11-07: T7.w.5c done (senior-dev; code-reviewer 1 round, no critical or high finding; ui
  373/373, lint, build). "Bildirimler" panel (`NotificationsPanel.tsx`), a bell in the top bar
  with the unread count (only with `notifications`), `#notifications` opens it and is cleared;
  `NotificationsView` in state.ts (also outside the 5c file list: the reducer the 5b no-op cases
  were waiting for). Narrowest readings: the phone record is `shadow.notificationsShown`
  (`{id: raised}`), so each raise is shown once (a renotify shows again, marking unread does not);
  an item that arrives while the app is in front only counts as shown; read items count as
  shown; the catch-up is the first list after each `welcome` (oldest first, record cut to the
  listed items). Urgent `speak` uses the reply path (`speak` frame, native fallback) and waits
  until no turn, recording, confirmation or streamed answer is in the way; "Durdur", voice
  replies off and a reconnect drop what still waits. `unknown_item` for an item already removed
  by a broadcast is swallowed (L4). Delete asks first in the panel. Round 1 fixed: the speech
  queue no longer runs from inside `dispatch` (microtask), is dropped by Durdur / voice off, is
  not held by an empty streamed answer and wakes on a silent `final` (5 mutations killed).
  Platform: `notify(title, body, item?)`; the Android adapter calls the optional bridge method
  `notifyItem(id, title, body, urgent)` and falls back to `notify` on older shells.
- 2026-11-07: T7.w.5d code and unit tests done (senior-dev; code-reviewer 1 round, no finding;
  `gradlew testDebugUnitTest assembleDebug` green, 76 unit tests). **Manual phone check pending**
  (acceptance: a test item while the app is in the background, two items as two notifications, a
  confirmation on its own channel, dismissing does not delete). `Notifier.kt`: channels
  "Onay istekleri" (unchanged id), "Bildirimler" (default importance, no sound, no vibration) and
  "Acil bildirimler" (high); items are keyed by tag `item:<id>` with their own id 2, so no item
  replaces the confirmation (id 1, no tag) or another item. Bridge `notifyItem(id, title, body,
  urgent)` (trusted page only, id checked, lengths capped as `notify`). No new permission or
  dependency. docs/03 (bridge table) not updated: outside the 5c/5d files.
