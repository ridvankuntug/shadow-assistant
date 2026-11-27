# Docs

Project documentation and plans.

- [`02-core-protocol.md`](02-core-protocol.md): Core WebSocket protocol, including protocol versioning.
- [`03-platform-adapter.md`](03-platform-adapter.md): platform adapter between the UI and the browser / Android shell.
- [`04-router.md`](04-router.md): router: execution tiers, escalation and usage records.
- [`05-deploy.md`](05-deploy.md): running Shadow Assistant at home.
- [`06-memory.md`](06-memory.md): assistant memory.
- [`07-speed.md`](07-speed.md): turn latency: persistent agent session, streamed speech, continuity.
- [`08-learning-fast-path.md`](08-learning-fast-path.md): learning fast path, Development tab, notification store (T7.w design).
- [`09-notification-producers.md`](09-notification-producers.md): notification producers for backup, services and HA alerts (T7.w.11 design).
- [`10-android-updates.md`](10-android-updates.md): signed GitHub Releases and in-app update for the Android app (T14).
- [`11-pc-control.md`](11-pc-control.md): PC control (`pc-svc`) and the switched permission list (T17 design; T17.2 permission list implemented).
- [`12-wake-and-headless-core.md`](12-wake-and-headless-core.md): waking the PC from the phone, and a Core that runs before sign-in (T21 design).
- [`13-pi-core-and-agents.md`](13-pi-core-and-agents.md): Core on the Pi, the PC system agent (`/agent` channel), the tray pipe and relay, voice proxy, release/update and file layout (v0.2 T10 design, awaiting review).
- [`14-intent-gate-and-confirmed-names.md`](14-intent-gate-and-confirmed-names.md): write gate (question lock, target provenance), confirmed device names and the repeated-error stop (T4 design and implementation).

Archive (completed plans, kept for history):

- [`archive/01-v1-plan.md`](archive/01-v1-plan.md): v1 plan and task list.
