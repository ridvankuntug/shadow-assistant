# 14 - Intent gate and confirmed device names

Status: design approved 2026-11-22 (T4.1); implemented (T4.2-T4.12).
Builds on [`02-core-protocol.md`](02-core-protocol.md) (permission gate, confirm
frames), [`04-router.md`](04-router.md) (tiers, tier 0), [`06-memory.md`](06-memory.md)
(memory surface) and [`08-learning-fast-path.md`](08-learning-fast-path.md)
(learned tier-0 rules).

The number 13 is unused at the time of writing; 14 was chosen by the plan.

Examples use generic names ("salon lambası", "bahçe pompası", a plug brand
"Sonoff"). Nothing here, and nothing the implementation commits, may hold real
room, device or person names, transcripts, addresses or tokens. Test fixtures use
the same generic names.

## Problem

Incident (2026-11-17, device name replaced with a generic one):

1. The user asked a list question: "Sonoff hangi cihazlar var".
2. Tier 0 found no rule (a question), so the turn went to tier 1.
3. The model called `homeassistant__GetLiveContext` three times with a `name`
   filter the tool does not support; HA returned an error each time and the
   gateway passed the error text back (no retry limit).
4. The model then guessed a device ("Bahçe Pompası") and called
   `intent__HassTurnOff` on it. `intent__HassTurnOff` is `write` in
   `services.yaml`, which today runs without confirmation, so the device was
   switched off.

A separate turn ("bahçe pompasnı kapat", a typo for "bahçe pompasını") did not
match on tier 0: `stemCandidates` strips suffixes from the last word only and does
not reach the right stem, so the name resolution returned `none` and the turn
fell back to the model.

Three failures meet here:

- **Intent.** A question or list request reached a write tool. Nothing in the
  Core knows that the turn was a question.
- **Target provenance.** The write target came from the model's guess, not from
  the user's words. The gate sees only `(tool, input)`; it has no notion of where
  the target came from, and `write` is never confirmed.
- **Repeated failing calls.** The same failing call shape was sent three times in
  one turn; nothing stops the model from repeating it.

User requests:

1. A question or list request never turns into an unapproved action. When the
   turn is a question, or the target of a write does not come from the user's
   words or from a confirmed mapping, the user is asked before the write runs.
2. When the user confirms "yes, this one, always", the name-to-device mapping is
   kept, can be seen and deleted, is not used while the HA device is missing,
   and becomes passive after 30 days missing.
3. Clear commands ("salon ışığını yüzde 40 yap") get no extra latency and no extra
   confirmation.
4. A tool that fails twice in the same way in a turn is not called the same way
   again in that turn.

## Scope

| In | Out (see [Out of scope and related](#out-of-scope-and-related)) |
|---|---|
| Write gate: question lock and target provenance check, in the shared gate (T4.3) | Removing `name` from the `GetLiveContext` schema (T6, plan decision O8b, T6.2) |
| Confirmed-name store: storage, identity, missing/passive status, use on tier 0 and in the gate (T4.4) | Note taking / a new memory kind (T5) |
| Confirm card option "Evet, hep bu", "Cihaz adları" panel (T4.4) | Android single notification id; a pending confirm lost on reconnect (risks only) |
| System prompt change for the "Araçlar" section (T4.2) | Fuzzy name matching in general; better suffix stripping |
| Per-turn repeated-error stop for model tool calls (T4.7) | HA-side aliases, entity registry subscriptions |
| Tests incl. the 2026-11-17 scenario and the no-regression checks (T4.5) | |

## Current state (what the design relies on)

- **One gate.** Model calls (`Session.gate`, `session.ts` ~1575) and tier-0 calls
  (`GatedCall` from `runDirectPlan`, `session.ts` ~862) both end in
  `Session.authorize` (`session.ts` ~1620-1698). Levels come from
  `services.yaml` via `ServicePolicy.levelFor` (`permissions.ts:86-111`): exact
  rule, first glob, service default; `confirm_inputs` only raises. `read` and
  `write` are allowed at once; `confirm` opens the `ConfirmBroker` (60 s, button
  or voice, first resolution wins; timeout and cancel never approve).
- **Model-only gate wrapper.** `Session.gate` runs before `authorize` for model
  calls only: it counts the call, applies the tier-service deny
  (`GateDeny = DenyReason | "tier_service"`, `session.ts:266`), records allowed
  `toolUseID`s, and maps a denial to `DENY_MESSAGES` (`session.ts:130`).
- **HA write tools** (`services.yaml:30-49`): `intent__HassTurnOn/Off`,
  `light__*`, `fan__*`, `todo__HassList*`, `intent__HassCancelAllTimers` are
  `write`. Lock, alarm, garage, cover, valve, script and satellite tools are
  `confirm`; unlisted HA tools are `confirm`.
- **Tier 0** (`direct.ts:62-115`) reads `GetLiveContext` on every turn (no cache),
  resolves the spoken `<ad>` slot with `resolveDevice`
  (`live-context.ts:95-140`: exact name/alias, name + keyword, area; exactly one
  best hit), applies the safety filters (`targetFilter`, deny-name words,
  outlet-only switches; `target_refused` always goes to the model), then makes one
  write call. Two HA calls per turn. Tier 0 already handles `declined` /
  `timeout` outcomes of a `confirm` level (`DenyReason`, `direct.ts:39`).
- **No `entity_id` in the Core.** `LiveEntity` is `{names[], domain, state,
  areas[], attributes}` (`live-context.ts:14-21`); only exposed entities appear.
  Whether HA's `GetLiveContext` text can carry an entity id was not verified.
- **The model path does not see tool result text.** `onToolResult` reports
  `isError` and an error text only (`session.ts` ~1288, ~1472); the learner makes
  its own `GetLiveContext` read after the turn (`session.ts` ~1063-1066).
- **Confirm protocol.** `confirm_request {requestId, id, tool, summary,
  expiresAt}`, `confirm_response {requestId, approved}`, `confirm_resolved`
  (`protocol.ts` ~50, ~500, ~595). Voice answers via `parseVoiceAnswer`
  (`permissions.ts:171`, at most 3 words of yes/no words).
- **Memory `alias`** entries are free text written by the extractor, not
  structured and not used by tier 0 (docs/06). **Learned rules** store phrase
  patterns, never name-to-entity (`learn/store.ts:35-37`, docs/08).
- **UI panels.** `App.tsx` holds one `Panel` union and renders one drawer at a
  time; the top bar "⋮" menu (`AppMenu.tsx`, `menu.ts`) takes a list of items
  (today "İzinler" behind a Core feature, "Güncelleme ve sürüm"). Memory is opened
  from Ayarlar (`Panels.tsx`) and only with the Core feature `memory`.

## Design overview

```
turn text ──► intent check (pure, at turn start) ──► ActiveTurn.question
                                                       │
tier 0: resolveDevice ─► confirmed-name fallback ─► call(tool, args, {provenance})
model:  tool call ─► repeated-error stop (T4.7) ──► gate(tool, input)
                                                       │
                              Session.authorize ◄──────┘
                                level (services.yaml, confirm_inputs)  unchanged
                                + write gate (new, only for target-checked services):
                                    question turn           → raise to confirm
                                                              (no "Evet, hep bu")
                                    provenance user/mapping → level unchanged
                                    provenance unknown      → raise to confirm
                                                              (card may offer "Evet, hep bu")
```

The write gate can only raise a level; it never lowers one and never denies by
itself. Every safety ceiling that exists today (`deny`, read-only mode, `confirm`
tools, `confirm_inputs`, tier-0 target filters) runs before or independent of
it. The repeated-error stop (Decision 10) is a separate, model-only deny in
`Session.gate`.

## Decision 1: where the gate lives

**Decision.** In `Session.authorize`, with the decision logic in a new pure
module `core/src/write-gate.ts` (no I/O, unit-testable). `Session` supplies the
turn context (question flag, the user-text window, provenance hint from tier 0,
confirmed names, a live-context snapshot when one is at hand).

**Why.** `authorize` is the only point both tier 0 and the model pass through,
and it already owns the confirm flow, the logs and the deny messages. The turn
text, which provenance needs, lives on `ActiveTurn` / `Session`.

**Alternative: `McpGateway.call`.** Rejected. The gateway is provider-neutral and
turn-agnostic by design; it would need the turn text pushed into it, and tier-0
calls do not go through it the same way. It keeps its current job (schema checks,
`tooLate`, error pass-through).

## Decision 2: what a "write" is

The gate applies to calls that pass all of:

1. The effective level (after `confirm_inputs` and a route `minLevel`) is
   `write` or `confirm`. `read` calls are never touched.
2. The tool's service has the new `services.yaml` flag `target_check: true`.
   v1 sets it only on the Home Assistant service. Built-in memory tools, the
   vault and PC control are unaffected (they have their own rules).

The two parts of the gate treat these calls differently:

| Part | `write` | `confirm` |
|---|---|---|
| Question lock | raised to `confirm`; card says it was a question; no "Evet, hep bu" | stays `confirm`; same question note on the card; no "Evet, hep bu" |
| Provenance check | unknown target → raised to `confirm` | already confirmed; provenance only decides whether "Evet, hep bu" is offered |

**Target arguments.** The provenance check looks at `name`, `area` and `floor`
(the HA intent targeting fields). A write call with none of them:

- with `domain` / `device_class` only (a broad call, e.g. "all lights"): known
  only if the user text contains a whole-set word (`tüm`, `bütün`, `hepsi`,
  `her`) and a word for the domain (from the router's keyword lists);
  otherwise unknown → confirm.
- with no target at all (`intent__HassCancelAllTimers`): no target to check;
  only the question lock applies.

`todo__HassList*` calls carry the list in `name`; the same text check applies
("alışveriş listesine ekle" names the list).

## Decision 3: question lock (deterministic)

**Decision.** At turn start the Core classifies the raw user text (before
`prepareText` removes punctuation) with a pure function `isQuestionTurn(text)`.
If it is a question, every write or confirm call of a target-checked service in
that turn is **raised to `confirm`** (user decision 1), whether or not the target
is known. The card carries a question note ("Soru sordun; yine de yapılsın mı?",
exact strings in T4.3), "Evet, hep bu" is never offered and nothing is stored.
The log reason is `…+gate:question_turn`; when the target is also unknown the
question reason wins (one suffix). The flag lives on `ActiveTurn` and holds
across tier-0 fallback and tier-1 → tier-2 escalation (same turn). The lock uses
the current turn's text only.

Signals (Turkish, after `fold`):

- question words anywhere: `hangi`, `hangileri`, `neler`, `ne`, `nedir`, `kac`,
  `kaç`, `nerede`, `listele`, `var mi`, `yok mu` (`say` is left out: "say" +
  plural object is ambiguous);
- a question particle `mi/mı/mu/mü` (and inflected `misin`, `midir`, …) **not**
  preceded by a polite-request verb form;
- a trailing `?` in typed text.

**Polite requests are commands, not questions.** Turkish asks for actions with a
question form: "ışığı açar mısın", "kapatabilir misin", "kısar mısınız". The
classifier excludes a particle that follows a verb in the aorist or the
"-abil/-ebil" form (`…ar/…er/…ır/…ir/…ur/…ür` + `mı…`, `…abilir/…ebilir` + `mi…`).
A trailing `?` alone does not lock a turn whose text is such a polite request.
Examples:

| Text | Locked |
|---|---|
| "Sonoff hangi cihazlar var" | yes (`hangi`, `var`) |
| "salon lambası açık mı" | yes (particle after adjective) |
| "salon lambasını kapatır mısın" | no (polite request) |
| "evdeki ışıkları listele" | yes (`listele`) |
| "salon ışığını yüzde 40 yap" | no |
| "hangi ışıklar açık, hepsini kapat" | yes (mixed: the model answers, its write call opens one card; approved → done in one turn) |

**Tier 0 in a question turn.** The built-in command rules rarely match a
question, but a learned or static rule can (e.g. a typed "salon ışığını kapat?").
**Decision: the same confirm card, not a fallback.** The tier-0 call goes
through `authorize` like any other; the question lock raises it to `confirm`
regardless of `provenance: "user"`, and the existing tier-0 `declined` /
`timeout` outcomes apply. Why: one rule for every path ("a write in a question
turn asks"), no new tier-0 outcome, no model round trip that would most likely
end in the same card. A fallback would cost ~2 s and still reach the card.

**Why confirm, not deny (user decision 1).** A question never acts without the
user's yes, and a mixed sentence ("… hepsini kapat") still completes in one turn.
The cost is a card in a question turn when the model wants to act; the system
prompt (Decision 9) tells the model not to act on a pure question, so the card
should be rare.

**Why deterministic, not the model.** A model-reported intent is exactly what
failed in the incident. A word list is predictable, testable and free. It is not
complete; the provenance check below is the second line for what it misses.

**Alternative: provenance check only, no lock.** Rejected: "salon lambası açık
mı" contains the target, so a model that turns the lamp off would pass the
provenance check. Only the lock raises that to a card.

## Decision 4: target provenance (deterministic)

A write target is **known** when one of these holds; otherwise it is
**unknown** and the call is raised to `confirm`.

1. **Tier 0 resolved it** (`provenance: "user"`). `runDirectPlan` passes a hint
   with its call (`GatedCall` gets an optional third argument `{ provenance }`);
   the target came from the spoken `<ad>` slot by construction. Zero extra work.
   Learned rules (docs/08) use the same executor and get the same hint.
2. **Tier 0 resolved it through a confirmed name** (`provenance: "mapping"`,
   Decision 6).
3. **Model call, text match.** Every target argument (`name`, `area`, `floor`),
   folded with the same `fold(cleanTurkish())` as tier 0, equals a contiguous
   word run of one user utterance in the window in which each word may be
   suffix-stripped with the tier-0 rules (`stemCandidates` applied per word, not
   only to the last word). No substrings, no single shared word: "pompa" does not
   cover "Bahçe Pompası".
4. **Model call, alias match.** If 3 fails, the Core looks the `name` up in a
   live-context snapshot: when exactly one exposed entity has that name, and any
   of that entity's names/aliases or its area (as with `resolveDevice`, score ≥ 2,
   or the area plus a keyword) matches a user utterance under rule 3, the target
   is known. This keeps "salon lambası" (an HA alias) working when the model calls
   the canonical name.
5. **Model call, confirmed name.** A user utterance in the window contains the
   key of an active confirmed name (Decision 6) whose target matches the call's
   `name` (and `area`, if given) and is present in the snapshot.

**Which text counts (user decision 6).** The **last 3 user utterances** of the
same session, the current one included, with no time limit. Assistant text never
counts: the model's own suggestion ("Bahçe Pompası'nı mı kastettin?") is the
guess the gate is there to catch. `<bilgi>` records of tier-0 turns count as user
text (they are the user's words). The window is kept on `Session` (a ring of 3
entries: folded text and the turn's unresolved spoken name, Decision 7); a new
session starts empty. The question lock uses the current utterance only.

So "salon ışığı açık mı?" followed by "kapat" works: turn 2 is not a question,
and the target is in the window. Once two more user utterances have followed,
the first one leaves the window and a "kapat" asks.

**The snapshot for rules 4 and 5.** The model path does not see tool result
text today. Options: (a) extend `onToolResult` to pass the result text of
`GetLiveContext` so the Core keeps the model's own read; (b) on a rule-3 miss,
read `GetLiveContext` once in `authorize` and cache it on the turn. **Decision:
(b).** It costs one HA read (typically well under the model's own 2 s turn) only
on the model path and only when the plain text match failed; tier 0 never pays
it. (a) touches the gateway and both model runners for a saving that matters
only on this rare path. If the read fails, the target stays unknown (confirm).

**Why deterministic, not the model.** A model self-report ("the user named this")
is not evidence. The fold/stem rules already exist, are pure and run in
microseconds.

**Known false "unknown" cases** (they get a confirm card, never a wrong action):
mis-heard names, synonyms the user never registered, pronoun-only follow-ups
once the naming utterance left the window ("onu da kapat" four utterances later),
choice answers that do not repeat the name ("ikincisi"). A confirm with
"Evet, hep bu" can create a confirmed name where the words are known, so repeated
cases go away.

## Decision 5: how confirmation is asked

**Reuse the existing confirm path.** A gate-raised level goes through
`ConfirmBroker` exactly like a lock today: same `confirm_request` /
`confirm_response` / `confirm_resolved` frames, same 60 s, same voice answers,
same `declined` / `timeout` deny messages to the model and outcomes on tier 0.

Changes:

- **Summary text.** `summarizeToolCall` gains an optional Turkish reason suffix
  for gate-raised confirms: unknown target, e.g. "Bahçe Pompası kapatılsın mı?
  Bu cihazın adını söylemedin."; question turn, e.g. "Bahçe Pompası kapatılsın
  mı? Soru sordun; yine de yapılsın mı?" (exact strings in T4.3).
- **Log reason.** The `tool_call` / `permission` records carry
  `reason: "…+gate:unknown_target"` or `reason: "…+gate:question_turn"`, so
  `conversation-log` and dev-notes can tell gate confirms from `services.yaml`
  confirms.
- **No new deny reason for the write gate.** It only raises to `confirm`; the
  existing `declined` / `timeout` / `cancelled` reasons cover every "no". (The
  repeated-error stop adds its own reason, Decision 10.)
- **Card option "Evet, hep bu"** (Decision 7).

## Decision 6: confirmed-name store

### Location and file

`<dataDir>/device-names/names.json`, written with `writeFileAtomic`, read with
`readJsonOrQuarantine`, one serial write chain (same pattern as
`fast-path/rules.json`). `resolveDataDir` already makes the data dir portable
(Windows now, Pi later); the file is plain JSON and part of the data-dir backup.
No SQLite.

### Schema (v1)

```json
{
  "version": 1,
  "names": [
    {
      "id": "n-3f9a1c",
      "spoken": "bahçe pompasnı",
      "keys": ["bahce pompasni", "bahce pompasn", "bahce pompas"],
      "target": { "name": "Bahçe Pompası", "domain": "switch", "areas": ["Bahçe"] },
      "status": "active",
      "missingSince": null,
      "createdAt": "2026-11-20T09:12:00.000Z",
      "lastUsedAt": "2026-11-21T18:40:00.000Z",
      "uses": 4
    }
  ]
}
```

- `spoken`: the words the user said (display), `keys`: its folded stem forms
  (match keys). One key may map to one target only; a new confirmation for the
  same key replaces the old entry (status `active`, `missingSince` null).
- `target`: the **fingerprint**: canonical name (first of `names`), domain,
  areas, as seen in the live context at confirmation time. `state` and
  attributes are not part of it.
- `status`: `active` | `passive`. `missingSince`: ISO time of the first valid
  snapshot that lacked the fingerprint since it was last seen, else `null`.
- Cap: 200 entries. At the cap a new entry is refused with a log line (nothing is
  evicted silently); the user deletes rows in the panel.

### Identity: fingerprint, not entity id (user decision 2)

The Core has no entity id. Options:

| Option | For | Against |
|---|---|---|
| **A. Fingerprint name + domain + areas** (chosen) | No new HA access; a rename or removal makes the entry missing directly | A device deleted and recreated with the same name and area is treated as the same; two entities with the same fingerprint are ambiguous (then the name is not used) |
| B. Entity registry id via a new read-only `ha-client` command | Stable across renames, can tell recreate from rename | Widens `READ_ONLY_COMMANDS` (a deliberate ceiling, `ha-client.ts:2-8`); still needs a link from registry entries to the exposed entities of `GetLiveContext` (not verified to exist); a rename would need an extra rule |
| C. Write an alias into HA | HA resolves it everywhere, tier 0 for free | The Core does not write to HA configuration (read-only WS by design); a model-only HA-side change the user cannot see in Shadow |

A is the v1 decision. B and C are not pursued.

### Missing and passive (user decision 4): checked against the live context already read

A **valid snapshot** is a parsed `GetLiveContext` result with at least one
entity. An error, an unparseable result, an empty entity list or a timeout is
not valid: it neither starts nor clears a missing clock. An entity whose `state`
is `unavailable` is present.

- **Present** (exactly one exposed entity with the fingerprint in a valid
  snapshot): `missingSince` is cleared if set; the entry is usable.
- **Ambiguous** (two or more): not used in that turn; counts as present for the
  clock (the device exists).
- **Missing** (none): not used in that turn (there is nothing to act on).
  `missingSince` is set to now if it is `null`. If `now - missingSince` is 30
  days or more, `status` becomes `passive`.
- **Where it is checked.** On every use (tier-0 lookup, gate rule 5) and in a
  sweep over all active entries after every valid snapshot the Core already
  holds (each tier-0 parse; the gate's rule-4 read). No extra HA read, no event
  subscription. "Aralıksız 30 gün" is measured from the first observed miss:
  any valid snapshot that shows the device clears the clock.
- **Passive entries** are never used for matching, never deleted automatically,
  are not swept, and show "Pasif" in the panel; the user can delete them.
- **Passive does not come back by itself.** When the fingerprint reappears, a
  passive entry stays passive; a new "Evet, hep bu" for the same words replaces
  it with an active entry. Why: after 30 days missing, a device with the same
  name, domain and area may be a different physical device (fingerprint
  limitation above); acting on it without a fresh yes would be a guess. A renewed
  entry costs one card. A missing entry inside the 30 days, in contrast, resumes
  at once when the device is back (short outages, HA restarts, an exposure
  toggled off and on).

Without HA registry events, a removal is noticed at the next valid snapshot, not
at once. That is enough: use always verifies, so a missing entry is never acted
on.

### Use on tier 0

`resolvePlanTarget` (`direct.ts`) tries `resolveDevice` first; **HA names and
aliases always win**. Only on `none` it looks up the slot's stem forms in the
active confirmed names, verifies the fingerprint in the snapshot, and continues
with that entity. The result then goes through the **same** safety filters
(rule domains, `targetFilter`, deny-name words, outlet-only switches): a
confirmed name never reaches a target the rule could not reach by its HA name,
and `confirm_inputs` / `confirm` levels and the question lock still apply in
`authorize`. The call carries `provenance: "mapping"`. Learned rules use the
same resolver, so they gain confirmed names without change.

No new HA calls: the confirmed-name lookup is an in-memory map over the
snapshot tier 0 already read.

## Decision 7: when a confirmed name is created (user decisions 3 and 7)

**Decision: a second approve option on the gate-raised confirm card, "Evet, hep
bu", offered only when the Core knows deterministically which words the user
used for the device.** There is no separate text confirmation: the assistant
does not ask "X'i mi kastettin?" and then show a card (no double yes,
Decision 9). When the target is unclear, the card is the question: "Evet /
Evet, hep bu / Hayır" or, without known words, "Evet / Hayır".

**Where the words come from.** When a tier-0 command rule (built-in, static or
learned) matched and its `<ad>` slot gave `name_not_found` or `name_ambiguous`,
the session stores that slot as the utterance's **unresolved spoken name** in the
user-text window (Decision 4). The offer is made when all hold:

1. the call was raised for an **unknown target** (not for a question turn, not
   by `services.yaml` / `confirm_inputs` alone);
2. the call has a single `name` target;
3. exactly one distinct unresolved spoken name exists in the last 3 user
   utterances (the current one included). None or more than one → no offer.

```
confirm_request { …, remember?: { spoken: "bahçe pompasnı", target: "Bahçe Pompası" } }
confirm_response { requestId, approved: true, remember?: true }
```

Both fields are optional and additive (protocol stays 1, docs/02 updated). An old
client ignores `remember` and shows plain Evet / Hayır. The Core validates that
`remember: true` refers to the offer it made for that `requestId`; it stores the
entry only if the call then succeeds (no `isError`).

Voice: "evet hep bu", "evet hatırla" (≤ 3 words, yes-word + `hep`/`hatirla`)
resolve as approved + remember; plain "evet" approves once.

**Technical limit: a key is never invented.** When no unresolved tier-0 slot
exists (the model chose a target for a free-form sentence), the card has two
options only. A wider derivation was considered: take the word run of the user
text closest to the name the model called (e.g. "pompayı" for "Bahçe Pompası").
It is computable, but "closest" is an estimate; stored as a key it would make a
guess permanent and could later map other words to the wrong device. Only words
a rule slot isolated are stored. This is a decided limit, not an open question.

Never created: from the extractor, from the model, from a `services.yaml`
confirm (lock etc.), from a question turn, from a declined or timed-out card.

**Alternatives.**

- Every "Evet" stores a mapping. Rejected: a one-off approval ("yes, this time")
  would silently become permanent.
- A separate mapping card ("X derken Y'yi mi kastediyorsun? Kaydedilecek.")
  after the action. Rejected: a second card and a new frame type for every
  first-time name, on top of the confirmations the new gate already adds.

## Decision 8: viewing and deleting (user decision 5)

**Decision: a separate "Cihaz adları" panel** (`ui/src/ui/NamesPanel.tsx`),
opened from the top bar "⋮" menu (`AppMenu` item `names`, shown when the Core
announces the feature `names`; no count badge). `App.tsx` gains the panel value
`"names"` and requests the list when the panel opens, like the other panels.
Rows show "bahçe pompasnı → Bahçe Pompası (Bahçe)", the status ("Pasif" for
passive; a missing entry inside the 30 days shows "Bulunamadı" with no other
effect), and Sil; deletion asks "Silinsin mi?" like memory rows. The panel does
not depend on memory being on.

Protocol (additive, `welcome.features` gains `"names"`):

```
→ { "type": "names_list" }
→ { "type": "names_delete", "ids": ["n-3f9a1c"] }
← { "type": "names", "items": [ { id, spoken, target, status, missingSince, lastUsedAt, uses } ] }
```

Every authenticated device may list and delete, as with memory; there is no
add/edit in the UI (entries come only from the card).

**Why not the Hafıza panel.** Memory is hidden when memory extraction is off,
and its entries are free-text facts with their own extractor, budget and topics
(docs/06); a structured mapping with fingerprint and status does not fit there,
and showing both together would let an extracted `alias` fact look like a
confirmed one.

**Why not the Development panel.** It is limited to `CORE_DEV_DEVICES` and holds
technical items (rule suggestions, tool errors). The user's own words for
devices are user data.

**Why the "⋮" menu.** It already lists stand-alone panels behind Core features
(İzinler) and takes items as data (`menu.ts` needs no change).

## Relation to learned rules and memory aliases

- **Learned rules (T7.w.2)** map phrasings to (tool, domain, binding) and resolve
  `<ad>` live; confirmed names map words to a target. They meet only in the
  resolver: a learned rule whose `<ad>` is a confirmed name works on tier 0 with
  no change to the learner. No duplication: the learner still never stores
  names (docs/08), and confirmed names never store a phrasing.
- A learned rule observed on a turn whose target was **gate-confirmed** (unknown
  target or question turn) must not count as an observation (the model's target
  was not the user's until the user said yes). T4.3 marks such calls so
  `observeCall` skips them.
- **Memory `alias`** facts stay free text for the model's context. They grant no
  provenance and are not read by tier 0. The extractor may write a similar fact
  after a confirm; that duplication is harmless (it never authorizes). Confirmed
  names do not feed the model prompt in v1 (tokens; the gate already lets a
  correct model call through via rule 5).

## Decision 9: system prompt (T4.2)

`core/prompts/system.md` is used for every tier; `tier1.md` is appended on
escalatable tier-1 turns (`agent.ts`, `index.ts:147`) and is left as it is. The
"Araçlar" section becomes (draft; lines 1, 2 and the last unchanged):

```
Araçlar:
- Yalnızca sana verilen araçları kullanabilirsin: Home Assistant (ev cihazları ve sensörler), Shadow vault'undan izinli notları okuma ve (varsa) kalıcı hafızayı listeleme ve unutma.
- Evin anlık durumu için önce durum okuma aracını kullan; cihaz adlarını ve alanları oradan öğren, uydurma.
- Kullanıcı yalnızca bir şey soruyor ya da listelemek istiyorsa ("hangi", "neler", "var mı", "açık mı") durumu oku ve cevapla; hiçbir cihazı açma, kapatma ya da değiştirme. Aynı cümlede açıkça bir işlem de istiyorsa (ör. "hangileri açık, hepsini kapat") cevapla ve işlemi yap; sistem önce kullanıcıdan onay alır.
- Değiştireceğin cihazı kullanıcının söylediği addan bul. Söylenen ada uyan tek bir cihaz varsa onu kullan; emin olmasan da "X'i mi kastettin?" diye metinle sorma, gerekirse sistem kullanıcıya onay kartı gösterir. Uyan birden çok cihaz varsa adlarını kısaca say ve hangisi olduğunu sor; hiç uyan yoksa bulamadığını söyle.
- Onay verilmezse işlemi tekrar deneme, durumu kısaca söyle.
- Bir araç hata verirse aynı çağrıyı aynı biçimde tekrarlama; en fazla bir kez farklı biçimde dene, olmazsa hatayı dürüstçe ve kısaca söyle. Sistem aynı biçimde iki kez hata veren bir çağrıyı o turda bir daha çalıştırmaz.
- Dosya sistemi, komut satırı veya internet erişimin yok; bunları istersen olmadığını söyle.
```

**One candidate (user decision 7).** The model calls the write; when the name
was not the user's, the system raises the card. No text question first, so the
user says yes once.

**Several candidates.** The model lists them briefly and asks which one. This is
a choice question, not a confirmation: the user's next utterance names the
device, so rule 3 makes the target known and no card appears. An answer that does
not repeat the name ("ikincisi") gets a two-option card (no known words).

The prompt lowers how often the gate fires; it is not the safety mechanism.
How to call `GetLiveContext` (no `name` filter) is T6's job: the gateway mirrors
its schema without the `name` property (`modelSchema` in `core/src/mcp-gateway.ts`).

## Decision 10: repeated-error stop (T4.7, user decision 8)

**Decision.** When a tool call fails twice in the same way within one turn, any
further call of that tool with the same argument class is denied for the rest of
the turn before it is sent, with the new reason `repeated_error`.

- **Argument class:** full tool name + the sorted set of top-level input keys;
  values are ignored. `homeassistant__GetLiveContext` with `{name: …}` is
  `homeassistant__GetLiveContext|name`; with no input, `…|` (empty set).
- **Same error:** a result with `isError` for a call the gate allowed, with the
  same **normalized error text**: NFC, `tr-TR` lower case, whitespace collapsed,
  digit runs replaced by `#`, cut to 200 characters; no text counts as `""`.
  Two such results for one argument class block that class.
  Why not `isError` only: two different failures of one shape (two names not
  found, the third name exists) would block a legitimate call. Why not the raw
  text: ids and numbers in error texts would make identical failures look
  different.
- **Not counted:** gate denials (not errors, existing rule), results of an
  aborted turn, successful results (they do not reset the count either).
- **Where: `Session.gate`, before `authorize`,** after the tier-service check.
  The turn state (`ActiveTurn`) lives in `Session`, so the count holds across
  tier-1 → tier-2 escalation of the same turn; checking before `authorize` means
  a blocked call never opens a confirm card. Failures are recorded from the
  existing `onToolResult` path (`toolUseId` → argument class, stored when the
  gate allowed the call). Not in `authorize`: that is shared with tier 0, which
  makes a single write call and gains nothing. Not in `McpGateway`: it is
  turn-agnostic and provider-neutral (Decision 1), and built-in tools would be
  missed.
- **Paths:** the model path only; all services and levels (the incident's
  failing tool was a `read`). Tier 0 is unaffected.
- **Deny reason and message:** `repeated_error` is added to `GateDeny` in
  `session.ts` (like `tier_service`), not to `DenyReason` in `direct.ts`, since
  tier 0 never produces it. Model message (English, like the other
  `DENY_MESSAGES`): "This tool failed twice in this form in this turn; do not
  try it again in the same form. Tell the user what happened."
- **Log / dev-note:** the usual deny records (`tool_call` level `deny`,
  `reason: "repeated_error"`, `permission`, tool status `denied`) and one logger
  line. No new dev-note kind: the two failures are already `tool_error` notes.
- **Module:** a small pure helper `core/src/repeat-guard.ts` (argument class,
  error normalization, per-turn counter); `ActiveTurn` holds one instance.

**Alternative: limit identical calls (same tool + same input values).** Rejected:
the incident's model varied the `name` value; the shape (an unsupported key) was
the repeated mistake.

## Speed: no regression for clear commands

- **Tier 0.** The question check is a pure function over a few words (run once
  per turn, microseconds). Tier-0 calls in non-question turns carry
  `provenance: "user"` or `"mapping"`, so `authorize` does no text matching, no
  HA read, no confirm. The call count stays two (`GetLiveContext` + the write).
  The confirmed-name lookup and the missing/passive sweep run over the snapshot
  already in memory.
- **Model path, clear command.** Rule 3 is in-memory. Rule 4 adds one HA read
  only when the model used a name the user did not say; that turn already costs
  ~2 s. The repeated-error check is one map lookup per call.
- **Measurement.** T4.5 checks call counts and the absence of `confirm_request`
  (deterministic), not wall time. `core/scripts/bench-turn.ts` is run by hand
  before and after T4.3 for a tier-0 brightness command; the `timing` record
  (`routeMs`, `durationMs`) should not move beyond noise.

## Failure modes

| Case | Behaviour |
|---|---|
| Question classifier misses a question | Provenance check still raises an unknown target to confirm; a known target in a missed question ("salon lambası açık mı" phrased oddly) can still act: accepted gap, covered by tests for common forms |
| Classifier locks a real command | The write asks with a card; the user approves once. Polite forms are excluded and tested |
| Live-context read in rule 4 fails | Target unknown → confirm |
| Confirm card times out / is cancelled / socket closes | Not approved (existing rule); nothing stored |
| `remember: true` for a request without an offer | Ignored (logged); approval still counts |
| Write after "Evet, hep bu" fails (`isError`) | Nothing stored |
| `names.json` corrupt | Quarantined (existing helper), starts empty, logged; tier 0 and the gate work without confirmed names |
| Two entities share a confirmed fingerprint | Entry not used (ambiguous); missing clock not started |
| HA returns an empty or broken live context | No missing clock started or cleared |
| Device missing, then back within 30 days | Not used while missing; used again once present, `missingSince` cleared |
| Device back after the entry went passive | Stays passive; a new "Evet, hep bu" renews it |
| Confirmed name points at a lock/cover etc. | Tier-0 filters refuse it (fallback to model); model path: `confirm_inputs`/`confirm` still ask |
| Model repeats a failing call shape | Third call denied `repeated_error`, not sent; the model tells the user |
| Same tool fails with two different errors | Not blocked (different normalized text); a third distinct failure is still sent |
| Many more confirm cards than before | See risks |

## Risks (not solved here)

- **More confirmations.** Model-path writes on names the user did not say, and
  writes in question turns, now ask. Confirmed names and the system prompt reduce
  this over time.
- **Android single notification id** (`Notifier.kt`): a second confirm request
  replaces the first notification. More gate confirms make this more visible.
  Tracked under docs/08 related findings / T7.w.5d.
- **Pending confirm lost on reconnect.** A gate-raised confirm that is lost is
  a non-action (fail-safe), but the user may think the device was switched. The
  existing bug stays; the gate makes it more frequent.
- **Turkish morphology.** The question classifier and per-word stemming are word
  lists; dialect or STT errors can slip through either way. Tests pin the common
  forms; new misses are fixed by adding words.
- **Snapshot race.** A device renamed between the snapshot and the call: HA
  rejects the old name (tool error), no wrong target.

## Out of scope and related

- **T6** (done; `GetLiveContext` schema without `name`, plan decision O8b, T6.2): stops
  the failing reads of the incident at the source. T4 does not depend on it: the
  gate blocks the wrong write and T4.7 stops the third failing call even if the
  model keeps calling with bad filters.
- **T5** (note taking, new memory kind).
- **Fuzzy matching** and better suffix stripping for typos like "pompasnı":
  confirmed names cover repeated typos per word; a general fix is separate.
- Android notification id, reconnect and pending confirms (risks above).

## Related findings (not in scope, need approval)

- `device-registry.ts` is about client devices, not HA devices; the name misleads
  readers of the HA code (rename candidate).
- `stemCandidates` strips suffixes only from the last word; per-word stemming in
  `write-gate.ts` (rule 3) may be worth sharing with `resolveDevice`, which would
  change tier-0 matching (needs its own tests and approval).
- A voice command to forget a confirmed name ("bu adı unut") is not designed;
  deletion is UI only in v1.
- A dev-note kind for gate events (gate confirms by reason, `repeated_error`
  denials) would show how often the gate fires; the logs carry the reason
  meanwhile.
- `summarizeToolCall` shows raw argument keys ("name: …; domain: …") on every
  confirm card, not only gate ones; a Turkish sentence per known intent would
  read better.

## Kararlar (kullanıcı, 2026-11-22)

1. **Soru turunda yazma onay kartına yükseltilir, reddedilmez.** Hedef bilinse de
   kart çıkar, log gerekçesi `+gate:question_turn`, "Evet, hep bu" sunulmaz;
   tier 0'da soru turunda eşleşen kural da aynı kartı açar (fallback yok).
   Bkz. Decision 2, 3, 5.
2. **Kimlik: ad + domain + alan parmak izi (seçenek A).** Bkz. Decision 6.
3. **Kalıcı kayıt yalnız onay kartındaki "Evet, hep bu" ile oluşur;** düz "Evet"
   tek seferliktir. Bkz. Decision 7.
4. **Bulunamayan cihaz:** kayıt silinmez; `missingSince` tutulur, cihaz dönünce
   temizlenir; aralıksız 30 gün bulunamazsa `status: "passive"` olur, eşleşmede
   kullanılmaz, panelde "Pasif" görünür, kullanıcı silebilir. Pasif kayıt cihaz
   dönünce kendiliğinden aktifleşmez; yeni "Evet, hep bu" ile yenilenir. Boş veya
   bozuk canlı bağlam saati başlatmaz. Bkz. Decision 6.
5. **Görüntüleme: ayrı "Cihaz adları" paneli,** "⋮" menüsünden açılır; kimliği
   doğrulanmış tüm cihazlar listeleyip silebilir. Bkz. Decision 8.
6. **Söz penceresi: aynı oturumda son 3 kullanıcı sözü** (bu tur dahil, süre
   sınırı yok); asistan sözleri sayılmaz; soru kilidi yalnız bu turu kullanır.
   Bkz. Decision 4.
7. **Çift onay yok:** asistan metinle "X'i mi kastettin?" diye sormaz; tek aday
   varsa çağırır, kartı sistem açar; birden çok aday varsa seçim sorusu sorar.
   "Evet, hep bu" yalnız Core kullanıcının sözcüklerini deterministik bildiğinde
   (pencerede tek bir çözülemeyen tier-0 `<ad>` yuvası) sunulur; teknik sınır:
   anahtar uydurulmaz. Bkz. Decision 7, 9.
8. **Tekrarlanan hata durdurma (T4.7) kapsama alındı:** bir turda aynı araç aynı
   argüman sınıfıyla aynı (normalize) hatayı 2 kez verirse o sınıf turun geri
   kalanında gönderilmez (`repeated_error`). T4.6 (docs/README satırı) görev
   listesinde kalır. Bkz. Decision 10.

### Ek kararlar (kullanıcı, 2026-11-22, uygulama sonrası)

9. **Yalnız `name` taşıyan hassas hedef (T4.5 açık maddesi) → seçenek A (T4.8):**
   geçit, yalnız `name` taşıyan bir yazma çağrısının hedefini canlı snapshot'tan
   bulur ve domain/device_class'ına `confirm_inputs` ile hassas tür kurallarını
   uygular. Kilit, outlet olmayan switch ve deny-name hedefi hedef bilinen
   (kural 3/4/5) olsa da her zaman kart açar. Snapshot okunamazsa kart.
10. **Kural 3 sınırı → canlı listeyle kontrol (T4.9):** model yolunda hedef
    kullanıcının sözündeki ada tam uymuyorsa (söz daha uzun ya da başka bir ad
    ifadesi içeriyor) ve snapshot'ta benzer adlı başka bir cihaz varsa kart açılır.
    Net tier-0 yolu etkilenmez (2 HA çağrısı, kart yok).
11. **Onay kartı özeti sesli okunur (T4.10):** TTS açıkken; sessiz saat kuralları
    geçerlidir.
12. **Öğrenme kapalıyken `domainWords` (T4.11):** geniş çağrılar ve alan + cihaz
    kelimesi için sözcük listesi öğrenmeden bağımsız olarak geçide verilir.
13. **Gözlemlenebilirlik ve test (T4.12):** `permission` log kaydına gerekçe;
    `ui/scripts/mock-core.mjs` `names_list` / `names_delete` / `names` ve
    `remember` alanlarını bilir; `welcome.features` "names" ve `remember` için
    protokol testleri.

## Implementation tasks

Boxes: `[ ]` not started, `[~]` started, `[x]` done. **Files** lists everything a
task may touch. Tasks that share a file run in order (**After**). **Data** marks
tasks that write persistent data.

| Task | Files | After | Data |
|---|---|---|---|
| T4.2 | `core/prompts/system.md` | – | – |
| T4.3a | `core/src/write-gate.ts` (new), `core/src/turkish.ts` (export/helpers only, no tier-0 behaviour change), `core/test/write-gate.test.ts` (new) | – | – |
| T4.3b | `core/src/session.ts`, `core/src/direct.ts`, `core/src/permissions.ts`, `core/src/services.ts`, `services.yaml`, `core/test/session.test.ts`, `core/test/router-tier0.test.ts`, `core/test/permissions.test.ts`, `core/test/services.test.ts`, `core/test/session-learn.test.ts`, `docs/04-router.md` | 4.3a | – |
| T4.4a | `core/src/confirmed-names.ts` (new), `core/test/confirmed-names.test.ts` (new) | – | `device-names/names.json` |
| T4.4b | `core/src/session.ts`, `core/src/direct.ts`, `core/src/live-context.ts`, `core/src/permissions.ts`, `core/src/protocol.ts`, `core/src/index.ts`, `docs/02-core-protocol.md`, `core/test/protocol.test.ts`, `core/test/session-names.test.ts` (new), `core/test/router-tier0.test.ts` | 4.3b, 4.4a | `device-names/names.json` |
| T4.4c | `ui/src/App.tsx`, `ui/src/ui/NamesPanel.tsx` (new), `ui/src/ui/namesPanel.test.ts` (new), `ui/src/ui/ConfirmCard.tsx`, `ui/src/ui/strings.ts`, `ui/src/protocol/types.ts`, `ui/src/protocol/protocol.test.ts`, `ui/src/assistant/controller.ts`, `ui/src/assistant/state.ts`, `ui/src/assistant/*.test.ts` | 4.4b (protocol shape) | – |
| T4.7 | `core/src/repeat-guard.ts` (new), `core/test/repeat-guard.test.ts` (new), `core/src/session.ts`, `core/test/session-repeat.test.ts` (new) | 4.4b (`session.ts`) | – |
| T4.5 | `core/test/write-gate-scenarios.test.ts` (new), `core/test/tiers.test.ts`, test fixtures under `core/test/` | 4.3b, 4.4b, 4.7 | – |
| T4.6 | `docs/README.md` (add the line for this document), this document (progress log, statuses) | T4.2-T4.5, T4.7 | – |

Parallel lanes: T4.2, T4.3a and T4.4a can start at once; the pure part of T4.7
(`repeat-guard.ts` + its test) can also start at once. `session.ts` serializes
T4.3b → T4.4b → T4.7 (session part); `direct.ts`, `permissions.ts` and
`router-tier0.test.ts` serialize T4.3b → T4.4b. T4.4c starts once the T4.4b
protocol shape is fixed and shares no file with the Core tasks.

- [x] **T4.2 — System prompt.** Durum: bitti
  - [x] Replace the "Araçlar" section of `core/prompts/system.md` with the
    Decision 9 draft.
  - [x] Leave `tier1.md` unchanged; check no test pins the old wording.
- [x] **T4.3a — Pure write gate.** Durum: bitti
  - [x] `isQuestionTurn(rawText)`: word list, particle rule, polite-request
    exclusion, trailing `?` rule.
  - [x] `targetProvenance(input, utterances, snapshot?, names?)`: rules 3-5,
    broad-call rule over the 3-utterance window; per-word stem forms (local to
    the gate).
  - [x] Table tests for every example in Decisions 3 and 4.
- [x] **T4.3b — Gate in the session.** Durum: bitti
  - [x] `services.yaml` `target_check: true` on the HA service; schema in
    `services.ts`.
  - [x] `ActiveTurn.question` set at turn start; session window of the last 3
    user utterances (folded text + unresolved spoken name), no time limit.
  - [x] `authorize`: question lock raises to confirm (tier 0 included, no
    remember), provenance raise to confirm, lazy turn-cached `GetLiveContext`
    read for rule 4; log reason `+gate:question_turn` / `+gate:unknown_target`.
  - [x] `GatedCall` third argument `{ provenance }`; tier 0 passes `"user"`.
  - [x] Summary reason suffixes in `summarizeToolCall` (unknown target, question).
  - [x] `observeCall`: gate-confirmed calls are not learning observations.
  - [x] docs/04: one paragraph on the write gate.
- [x] **T4.4a — Confirmed-name store.** Durum: bitti
  - [x] Load/quarantine/atomic write, serial chain, cap 200 (refuse + log).
  - [x] `lookup(keys)`, `verify(snapshot)`, `sweep(snapshot)` (`missingSince`
    set/clear, `passive` after 30 days, injected clock; nothing on an invalid
    snapshot; passive never reactivated), `add` (replaces same key, active),
    `delete`.
- [x] **T4.4b — Names in tier 0, gate and protocol.** Durum: bitti
  - [x] `resolvePlanTarget`: confirmed-name fallback after `resolveDevice`, then
    the same safety filters; provenance `"mapping"`.
  - [x] Sweep after each valid snapshot (tier-0 parse, gate rule-4 read).
  - [x] Gate rule 5 with the store.
  - [x] `confirm_request.remember?`, `confirm_response.remember?`; offer only on
    an unknown-target raise, a single `name` target and exactly one unresolved
    spoken name in the window; never in a question turn; store on success.
  - [x] `parseVoiceAnswer`: "evet hep bu" / "evet hatırla" → approve + remember.
  - [x] `names_list` / `names_delete` / `names` (with `status`, `missingSince`),
    `welcome.features: "names"`; docs/02 updated.
- [x] **T4.4c — UI.** Durum: bitti
  - [x] ConfirmCard: third button "Evet, hep bu" when `remember` is present.
  - [x] `NamesPanel.tsx`: rows, "Pasif" / "Bulunamadı" labels, Sil with
    "Silinsin mi?"; strings in `strings.ts`.
  - [x] `App.tsx`: panel value `"names"`, "⋮" item "Cihaz adları" behind the
    feature `names`, list request on open.
  - [x] Controller/state/types and tests (`namesPanel.test.ts`, protocol, assistant).
- [x] **T4.7 — Repeated-error stop.** Durum: bitti
  - [x] `repeat-guard.ts`: argument class (tool + sorted top-level keys),
    error-text normalization, per-turn counter; unit tests.
  - [x] `Session.gate`: check before `authorize` (after the tier-service check),
    record allowed `toolUseId` → class, count `isError` results from
    `onToolResult`; skip aborted turns.
  - [x] `GateDeny` gains `repeated_error`; `DENY_MESSAGES` text; deny records and
    log line.
  - [x] Session tests: two identical failures → third call not sent; different
    error texts → not blocked; other argument class → not blocked; tier 0
    unaffected; count survives tier-1 → tier-2 escalation.
- [x] **T4.5 — Scenario tests.** Durum: bitti
  - [x] 2026-11-17: "Sonoff hangi cihazlar var"; the fake model calls
    `GetLiveContext` with `name` and gets the same error twice → the third such
    call is not sent (`repeated_error`); then it calls `intent__HassTurnOff` on
    "Bahçe Pompası" → exactly one `confirm_request`, no `remember` offer;
    declined → no HA write; timed out → no HA write.
  - [x] Mixed "hangi ışıklar açık, hepsini kapat" → one card, no `remember`;
    approved → write runs.
  - [x] Tier-0 rule matched in a question turn (typed "salon ışığını kapat?") →
    card, no `remember`; declined → no write.
  - [x] Model guesses on a non-question ("şunu kapat") → one `confirm_request`
    with two options; declined → no write.
  - [x] Tier-0 "salon ışığını yüzde 40 yap": exactly two HA calls, no
    `confirm_request`, no extra `GetLiveContext`.
  - [x] Tier-0 on/off and a learned rule: no `confirm_request`.
  - [x] Model call with the canonical name for an HA alias the user said → no
    `confirm_request` (rule 4, one extra read).
  - [x] "salon ışığı açık mı" → "kapat": allowed; with two other utterances in
    between (the naming utterance is 4th back and left the window) → confirm.
  - [x] Model asks which of several candidates; the user's next utterance names
    one → the write runs with no card.
  - [x] Polite request "salon lambasını kapatır mısın": not locked.
  - [x] "bahçe pompasnı kapat" → tier-0 miss → model call → card with `remember`
    → "Evet, hep bu" → next "bahçe pompasnı kapat" runs on tier 0 with no card.
  - [x] Device missing from the fixture → entry not used, `missingSince` set,
    model call asks again; device back before 30 days → `missingSince` cleared,
    tier 0 uses it; missing 30 days (injected clock) → `passive`, not used even
    when the device returns; a new "Evet, hep bu" makes it active.
  - [x] Confirmed name pointing at a lock / non-outlet switch / deny-name target:
    refused on tier 0, confirm on the model path.
  - [x] Broken/empty live context neither starts nor clears `missingSince`.
- [x] **T4.6 — Docs index.** Durum: bitti
  - [x] Add this document to `docs/README.md` (left out of T4.1 on purpose).
  - [x] Progress log and statuses in this document after T4.2-T4.5 and T4.7.

- [x] **T4.8 — Sensitive name-only targets (decision 9).** Durum: bitti
  - [x] Gate: resolve a name-only write target in the live snapshot; apply
    `confirm_inputs` (domain/device_class) and the tier-0 sensitive rules
    (lock, non-outlet switch, deny-name) → always confirm; unreadable snapshot → confirm.
  - [x] Tests incl. the open T4.5 item (confirmed name on a lock / non-outlet switch / deny-name).
- [x] **T4.9 — Rule 3 checked against the live list (decision 10).** Durum: bitti
  - [x] Model path: text match that is not an exact fit for the user's name phrase
    and a similarly named other device in the snapshot → confirm.
  - [x] Tests: "salon lambası 2 kapat" + call "Salon Lambası" → card; tier-0
    brightness still two HA calls and no card.
- [x] **T4.10 — Confirm summary spoken (decision 11).** Durum: bitti
  - [x] Speak the confirm summary when TTS is on; quiet-hour rules apply; tests.
- [x] **T4.11 — `domainWords` without learning (decision 12).** Durum: bitti
  - [x] Pass router keyword lists to the gate independent of `deps.learning`; test with learning off.
- [x] **T4.12 — Logs, mock core, protocol tests (decision 13).** Durum: bitti
  - [x] `permission` log record carries the gate reason.
  - [x] `ui/scripts/mock-core.mjs` knows `names_list` / `names_delete` / `names` and `remember`.
  - [x] Protocol tests for `welcome.features` "names" and `remember` (core and ui).

## Progress log

- 2026-11-22: T4.1 design written (this document).
- 2026-11-22: user decisions 1-8 applied; design approved.
- 2026-11-22: T4.2-T4.4c and T4.7 implemented; scenario tests T4.5 added
  (`core/test/write-gate-scenarios.test.ts`, shipped `router.yaml` / `services.yaml`).
  Open: a confirmed name that points at a lock, a non-outlet switch or a deny-name
  target is refused on tier 0, but on the model path only a call that carries
  `domain` (e.g. `lock`, through `confirm_inputs`) asks; a call with `name` only is
  known through rule 5 and runs without a card. Awaiting a decision.
- 2026-11-25: follow-up decisions 9-13 implemented (T4.8-T4.12); the open T4.5
  item is closed by T4.8 (name-only sensitive targets always ask).
