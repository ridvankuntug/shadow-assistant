# Router: execution tiers, escalation and usage records

The Core sends each user turn to the cheapest tier that can handle it. It moves
to a higher tier only when the lower one cannot do the job.

| Tier | Who answers | Used for |
|---|---|---|
| 0 | nobody (no model) | Common Turkish home commands matched by a pattern in [`router.yaml`](../router.yaml): lights and switches on/off, light brightness, temperature and humidity questions. |
| 1 | `CORE_MODEL_TIER1` (default `haiku`) | Every request no rule claims: short chat, simple questions, one tool call. |
| 2 | `CORE_MODEL_TIER2` → `CORE_MODEL` → `sonnet` | Escalations from tier 1, requests longer than `tier1.max_words`, tier-2 rules (compare, summarise …). |
| 3 | `CORE_MODEL_TIER3` (default `opus`) | Only explicit planning / deep-analysis requests matched by a tier-3 rule. |

`CORE_ROUTER=off` turns routing off: every turn runs on the tier-2 model, as
before T7. Code: [`router.ts`](../core/src/router.ts) (decision),
[`router-config.ts`](../core/src/router-config.ts) (file, validation, patterns),
[`turkish.ts`](../core/src/turkish.ts) (normalization),
[`direct.ts`](../core/src/direct.ts) + [`live-context.ts`](../core/src/live-context.ts)
(tier 0), [`mcp-direct.ts`](../core/src/mcp-direct.ts) (MCP client),
[`session.ts`](../core/src/session.ts) (execution),
[`usage-log.ts`](../core/src/usage-log.ts).

## router.yaml

The file is committed, so it holds no real room or device names. Patterns use
the `<ad>` placeholder; the Core resolves it against the entities Home Assistant
exposes when the request comes in. The file is validated with zod at startup.
An invalid file stops the Core with a list of problems, each with its path, for
example `rules.2.domains: required for switch rules`.
`SHADOW_ROUTER_FILE` points to another file.

```yaml
version: 1
fillers: [lütfen, …]          # whole words dropped before matching
groups:                       # named alternative lists, used as {@name} in patterns
  light-up: [yak, yakar mısın, yakmayı dener misin, …]
tier1: { max_words: 30, services: [..] }   # services: optional MCP allowlist per tier
tier2: { services: [..] }
tier3: { services: [..] }
escalation: { enabled: true }
direct:
  enabled: true
  on_tool_error: fallback     # fallback | reply
  max_name_words: 4
  stop_names: [şunu, ışığı, …] # captured "names" that never mean a device
  name_stop_words: [ve, sonra, mı, …]  # a captured name holding one of these does not match
  area_aliases:               # place names that mean the same; tried when a name is not found
    - [salon, oturma odası]
  max_items: 4                # sensors per answer
  messages: { not_found, ambiguous, unavailable, failed, declined, read_only }
rules:
  - id: light-on              # kebab-case, unique
    tier: 0                   # 0 | 1 | 2 | 3
    patterns: ["<ad> {@light-word} {@open|@light-up}"]
    # tier 0 only:
    service: home-assistant   # services.yaml MCP service
    tool: intent__HassTurnOn  # intent__HassTurnOn | intent__HassTurnOff | light__HassLightSet | homeassistant__GetLiveContext
    domains: [light, switch]  # switch rules: entity domains that may be touched
    keywords: [ışık, lamba]   # switch rules: device words allowed after the name
    sensor: temperature       # GetLiveContext rules: temperature | humidity
    default_name: ev          # sensor rules without <ad>: preferred sensor name/area
    permission: confirm       # optional; can only RAISE the services.yaml level
    reply: "Tamam, {ad} ışığı açıldı."     # {ad}; light-set also {seviye}, sensors also {deger}
    reply_many: "Sıcaklıklar: {liste}."    # sensors, several readings
```

Rules with tier 1 to 3 only take `id`, `tier` and `patterns`. They force a model
tier: tier 3 rules are the only way to reach Opus, and tier 2 rules skip a tier-1
attempt that would probably escalate anyway.

### Pattern syntax

A pattern describes the whole utterance. Rules are tried in file order and the
first match wins.

| Token | Meaning |
|---|---|
| `word` | literal word |
| `word*` | word prefix (`analiz*` matches `analizi`, `analizini`) |
| `{a\|b c}` | alternatives; one may have several words; `{a\|}` = optional |
| `{@name}` | the list `groups.name`; mixes with literals and other groups (`{@open\|@light-up\|}`) |
| `<ad>` | the device or place name, 1 to `max_name_words` words (one per pattern) |
| `<sayi>` | a number of 1 to 3 digits; only in `light__HassLightSet` rules, where values over 100 do not match |
| `*` | any number of words, including none |

Before matching, both the text and the patterns are normalized:

- lower-cased with Turkish rules (`İ`→`i`, `I`→`ı`);
- an apostrophe suffix is dropped (`Salon'u`, `Mutfak’taki`, `50'ye` → `salon`, `mutfak`, `50`);
- a percent sign becomes the spoken word (`%50`, `50%` → `yüzde 50`);
- other punctuation becomes a space, and repeated whitespace collapses to one space;
- filler words are removed;
- Turkish letters are folded to ASCII for comparison (`isigini ac` = `ışığını aç`).

Folding maps exactly one character to one character, so the captured `<ad>` is
cut from the unfolded text and keeps its Turkish letters. The Core can then say
the name back as the user said it ("yatak odası").

### Shipped tier-0 patterns

| Rule | Example utterances | Tool |
|---|---|---|
| `light-on` / `light-off` | "<ad> ışığını / ışığı / lambasını / ışıklarını aç · yak · açar mısın · yakabilir misin · yakmayı dener misin", "… kapat · söndür · kapatır mısın · söndürür müsün"; also verb first ("yak salonun ışığını") and name last ("ışığı kapat oturma odasının") | `intent__HassTurnOn` / `Off` |
| `light-level` | "<ad> ışığını %50 yap", "<ad> ışığın seviyesini yüzde 30'a ayarla", "ışığın seviyesini %50 yap <ad>" (yap · ayarla · getir, polite forms too) | `light__HassLightSet` (`brightness`, lights only) |
| `device-on` / `device-off` | "<ad>'ı aç", "<ad>u kapat", "<ad>i çalıştır", "<ad> durdur" | `intent__HassTurnOn` / `Off` |
| `temperature-home` | "evde sıcaklık kaç", "ev sıcaklığı nedir", "sıcaklık ne kadar" | `homeassistant__GetLiveContext` |
| `temperature-place` | "<ad> sıcaklığı kaç", "<ad>da sıcaklık kaç", "<ad> kaç derece" | `homeassistant__GetLiveContext` |
| `humidity-home` / `humidity-place` | "nem ne kadar", "evde nem kaç", "<ad> nemi kaç" | `homeassistant__GetLiveContext` |

These go to a model on purpose:

- Questions about the past ("ışığı ne zaman açtım") do not match, because the
  patterns are anchored and need the imperative.
- References with no name ("kapat şunu", "şunu kapat", "ışığı aç") do not match
  or hit `stop_names`.
- Negative commands ("salon ışığını açma") and several sentences in one turn
  ("Salonun ışığını yak. Sonra …") do not match: a pattern is the whole
  utterance. A capture that holds a `name_stop_words` word ("ışığı kapat ve
  mutfağı aç") is not a name.
- A level over 100 ("150'ye", usually a mis-heard "%50'ye") does not match.
- Relative level changes do not match: "yüzde 10 yükselt" means +10, not 10,
  and the dative that would mark a target ("%30'a indir") is dropped during
  normalization, so `set-to` holds absolute verbs only (yap · ayarla · getir).
  yükselt · artır · indir · düşür · azalt · çıkar · çek go to the model.
- A negative level ("-20", "%-20") does not match: the sign is kept as the
  word "eksi".
- Texts longer than 200 characters (after normalization) never match a tier-0
  rule; they are not a short home command.
- State questions ("<ad> açık mı") are not tier 0 in v1.
- Locks, covers, alarms and other domains outside a rule's `domains` are never
  handled at tier 0.

## Tier 0: direct calls without a model

1. The session gets a plan from the router: rule, service, tool and the captured
   name.
2. **Live context (read).** The session calls `homeassistant__GetLiveContext`
   through the direct MCP client, which uses the same
   `${HA_URL}/mcp_server/sse` endpoint and `Bearer HA_CORE_TOKEN` as the Agent
   SDK (`/api/mcp` is not used). The result is a JSON line with a YAML entity
   list, parsed by `parseLiveContext`.
3. **Switch rules: name resolution.** The spoken name is matched against the
   exposed entities of the rule's `domains`. Its last word may carry a case
   suffix without an apostrophe (accusative `salonu`, `lambayı`, `odasını`;
   genitive `salonun`; locative `salonda`, `odasında`, `salondaki`; softening
   `mutfağı` → `mutfak`), so several stem candidates are compared. Each entity
   gets a score:
   - 3: a name or alias equals the spoken name;
   - 2: a name starts with the spoken name and continues only with keywords or
     numbers ("yatak odası" → "Yatak Odası Işık", "… Işık 1");
   - 1: keyword rules only, the entity's area equals the spoken name.

   Exactly one entity must hold the best score. Otherwise the request counts as
   *not found* or *ambiguous*. When nothing at all matches, the name's
   synonyms from `direct.area_aliases` are tried in turn ("salon" →
   "oturma odası"); an ambiguous name is never replaced by a synonym. Home
   Assistant's live context lists area names but not area aliases, so the
   synonyms live in `router.yaml` (generic Turkish words only; a home's own
   names belong in HA). The intent is then called with the entity's real
   name and its domain, `{name, domain: [<domain>]}`; `light-level` adds
   `brightness` (0 to 100). Passing the domain keeps
   `confirm_inputs: domain: [lock, …]` effective even for name-based calls.
4. **Sensor rules.** Numeric `device_class: temperature|humidity` sensors (and
   `climate` current values) are filtered:
   - by the spoken name (area, label or name words);
   - else by `default_name`, if any sensor matches it;
   - else all sensors are used.

   Readings with the same label are merged. The answer uses words, not unit
   symbols ("21,5 derece", "yüzde 48"). The parser does not need a model; if
   the context cannot be parsed, the request is treated as a failed call (see
   below).
5. **Permission gate.** Every call, the read included, goes through the same
   gate as the model's tool calls:
   - the services.yaml level applies (read / write / confirm);
   - `confirm_inputs` applies;
   - a rule's `permission` can only raise the level;
   - with `CORE_READ_ONLY=1`, everything except reads is denied;
   - `confirm` opens the normal confirmation (button, voice or timeout).

   The client sees the usual `tool` (started/done/denied/error) and
   `confirm_request` frames.
6. **Answer.** The reply template is filled in and sent as one
   `assistant_delta` plus `assistant_done`. The turn is written to the
   conversation log (`route`, `tool_call`, `permission`, `tool_result`,
   `assistant`, `usage`).

The model never sees tier-0 exchanges, so the Core tells it afterwards. Each
exchange is a record `Kullanıcı: … / Shadow: …` between `<bilgi>` and
`</bilgi>` lines (`wrapDirectNotes` in `agent.ts`); `system.md` tells the model
not to answer these records and to answer the request after them. That way
"salon ışığını aç" followed by "şimdi kapat" still has its context.

- Persistent mode (default, see [07](07-speed.md#a1-persistent-per-device-agent-session)):
  when the device's model session is running, the record is appended to the
  conversation at once without a model call (`ProviderSession.appendNote`, SDK
  `shouldQuery: false`). It then survives reconnects.
- Otherwise (`CORE_AGENT_PERSISTENT=off`, no session running, or the note was
  refused) the session keeps the last five records and puts them in front of
  the next model prompt.

### Failures

| Situation | Behaviour |
|---|---|
| name not found / ambiguous, sensor not found, HA tool error, unparseable context | `on_tool_error: fallback` (default): the turn moves to tier 1, and nothing in the home has changed. `reply`: the short message from `messages`. |
| HA unreachable (connect/transport/timeout) | Always the `unavailable` message; a model could not reach HA either. |
| permission denied in read-only mode, confirmation declined or timed out | Always `read_only` / `declined`; never handed to a model, so the model cannot retry the action. |
| turn cancelled | `assistant_done` with empty text. |

**Why `fallback` is the default.** Tier 0 only matches exact names, aliases,
keyword forms and area matches. Spoken names often differ from HA names: "the
lamp next to the sofa", a nickname, or two lamps in one room. In those cases the
model can look at the live context and pick the device or ask back. Falling back
costs one Haiku call, but the user still gets the job done instead of "Bu adla
bir cihaz bulamadım". Safety does not depend on the setting: a fallback happens
only before any write succeeded (or when HA rejected the write), and the model's
own tool calls pass the same gate. `reply` suits setups that want zero model
calls for home commands.

## Tiers 1 to 3 and escalation

### Decision (no model call)

The router classifies the text with rules only:

- a tier-0 rule produces a direct plan;
- a tier-1, tier-2 or tier-3 rule forces that tier;
- otherwise, text longer than `tier1.max_words` goes to tier 2 and everything
  else to tier 1.

There is no separate classifier call.

### Tier-1 escalation

[`core/prompts/tier1.md`](../core/prompts/tier1.md) is part of the one static
system prompt, written conditionally: its rule applies only to a user message
whose first line is `[mod:hizli]`. The Core adds that line to escalatable
tier-1 turns (`buildTurnEnvelope` in `agent.ts`). For such a request, if it
clearly needs several steps or devices, a plan, a comparison or a long
explanation, Haiku must answer with exactly `[[ESCALATE]]` and nothing else,
preferably before using any tool. Greetings, small talk and thanks are never
escalated.

- The tier-1 answer is **buffered**: the client gets it as one
  `assistant_delta` after the call ends, so the marker is never shown or spoken
  (also not by the sentence-by-sentence speech stream). Tool frames still
  stream live.
- When the answer contains the marker (and the call did not fail, hit the usage
  limit or get cancelled), the turn continues on tier 2.
- A tier-1 *error* does not escalate. An auth or API error would just fail
  again, at higher cost. The usage limit never escalates either.
- Tier 2 never escalates to tier 3; Opus is reached only by tier-3 rules.

**Persistent mode** (default; one live model session per device, see
[07](07-speed.md#tier-switching-and-escalation)): the escalation continues in
the **same session**. The model is switched to tier 2 (`setModel`) and a second
message asks it to complete the user's last request, using any tool results
and not repeating successful actions. The tier-2 model sees the original
request, the tier-1 marker and any tool results. No fork, no resume. The
tier-1 attempt (request plus marker) stays in the history; that costs a few
tokens.

**Legacy mode** (`CORE_AGENT_PERSISTENT=off`, and single turns that fall back
to it when a device session cannot start): a fresh SDK query per call.

- When an earlier SDK session is resumed, tier-1 calls run with
  `forkSession: true`, so the pre-turn session is left untouched. Tier 2
  resumes that pre-turn session; the abandoned tier-1 attempt is not in the
  history.
- If tier 1 already **ran tools** before escalating, tier 2 resumes the tier-1
  fork instead. It sees the tool results and gets the instruction not to repeat
  successful actions, so nothing runs twice.

### Cost

| Path | Model calls |
|---|---|
| tier 0 | 0 |
| tier 0 → fallback | 1 (Haiku), 2 if Haiku escalates |
| tier 1 answers | 1 (Haiku) |
| tier 1 escalates | 2: one short Haiku call (output is a few tokens; the input is mostly a cache read) plus the Sonnet call |
| tier 2 / 3 rule or long input | 1 |

The escalation costs extra only when it happens, never on every turn as a
classifier call would. The `max_words` and tier-2 rules route the obvious cases
straight to Sonnet, which avoids a wasted Haiku call.

## Prompt caching and tool loading (T7.5)

What the Agent SDK allows, and what is done:

- **Static system prompt.** One fixed prompt for all tiers: `system.md` plus
  the conditional `tier1.md` (see [Tier-1 escalation](#tier-1-escalation)).
  It is byte-identical on every turn and for every model, and the tool list
  comes in a fixed order, so the SDK's automatic prompt caching hits. The usage
  records show this as `cacheReadTokens`. The prompt is passed as
  `{type: "custom", snapshot: false}`. In persistent mode it is fixed when the
  device's session starts. In legacy mode the tier-1 paragraph is still
  appended only for tier-1 turns, and `snapshot: false` keeps a resumed session
  from reusing the prompt of the tier it started on.
- **No tools when none are needed.** Tier 0 starts no Agent SDK process. It
  loads none of the MCP tool definitions (Home Assistant's 13 tools are roughly
  1,700 tokens) and sends no system prompt.
- **Per-tier services.** `tierN.services` in `router.yaml` limits the services
  a tier may use (default: all enabled services, because tier 1 needs Home
  Assistant for one-tool requests).
  - Persistent mode: the device's session loads every enabled service once, so
    the tool list stays stable. The permission gate denies tools of a service
    that is not in the current tier's list ("This tool is not available in
    this mode.", conversation log `tool_call` with reason `tier_service`). This
    is an execution limit only: the tokens of those tool definitions are not
    saved. The Core logs a warning at start-up when the key is set.
  - Legacy mode: only the listed MCP servers are loaded for the call, which
    also saves their tokens.

What is not done, and why:

- **Deferred tool loading (tool search).** The SDK can defer MCP tools behind
  tool search (`alwaysLoad: false`). It is not used: tool search needs a model
  that supports it (not guaranteed for Haiku), and it adds an extra round trip
  per tool lookup. With 13 + 2 tools, the cached definitions are cheaper than
  a search step. The remote servers keep `alwaysLoad: true`.
- **Per-request tool subsets inside a server.** The SDK loads a server's tools
  as a whole; the Core cannot know before the call which HA tool the model will
  need.
- **Cross-tier cache.** The prompt cache is per model, so a tier-1 → tier-2
  escalation does not reuse tier 1's cache: the first turn on a model after a
  switch writes that model's cache, and returning to a model within the cache
  lifetime reads it again. This is inherent to the API.

## Usage records

Each model call writes one JSON line to `<SHADOW_DATA_DIR>/usage/YYYY-MM-DD.jsonl`
(local date). So does each tier-0 turn, with `model: "none"`. An escalated turn
therefore writes two lines, and a tier-0 fallback writes two (tier 0, then
tier 1). The folder gets its own `.gitignore` containing `*`. Writes are
serialized, and a failed write only produces a warning.

```json
{"ts":1767340800000,"sessionId":"…","turnId":"t1","tier":1,"model":"haiku",
 "inputTokens":1830,"outputTokens":12,"cacheReadTokens":1790,"cacheWriteTokens":0,
 "costUsd":0.0004,"durationMs":900,"services":["home-assistant"],
 "tools":["homeassistant__GetLiveContext"],"outcome":"escalated"}
```

| Field | Meaning |
|---|---|
| `ts` | epoch ms |
| `tier` | 0 to 3 |
| `model` | model alias/id, `none` for tier 0 |
| `inputTokens` | total input, cache reads and writes included (same meaning as the conversation log) |
| `cacheReadTokens` / `cacheWriteTokens` | prompt-cache part of `inputTokens` |
| `costUsd` | SDK estimate, if reported |
| `services` / `tools` | services and service-relative tool names used in this call |
| `outcome` | `done`, `escalated`, `fallback`, `error` or `cancelled` |

Only these whitelisted fields are written. Tokens, headers and tool arguments
never appear in this file.

In persistent mode a call's usage is known only when the model session reports
the end of the call, shortly after the answer is shown; the line is written
then. `costUsd` is the difference of the session's running total and is left
out for the first call after a resume. A usage-limit stop is recorded as
`error`. Each model turn also writes a `timing` entry to the conversation log
(not to this file): route, first text, visible end, model duration and first
speech chunk, in ms from the request ([07 §Usage records](07-speed.md#usage-records-and-the-conversation-log)).
