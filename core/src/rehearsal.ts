/**
 * Rehearsal flag (T11.5, docs/13): while the Pi Core is rehearsed next to the
 * live PC Core, both are connected to Home Assistant. CORE_REHEARSAL on keeps
 * the rehearsal Core from raising and speaking the same notifications twice:
 * its notification producers are not started (here) and urgent speech is off
 * (NotificationCenter `urgentSpeech: false`, the second guard). The inbox
 * itself (list, read, delete) keeps working.
 *
 * Exception (T20): the Claude login check still runs in rehearsal. It watches
 * this Core's own Claude login (on the Pi), which the live PC Core does not
 * report, so nothing is raised twice.
 */
import type { ProtocolFeature } from "./protocol.js";
import type { Logger } from "./session.js";

/** What CORE_REHEARSAL turns off; the startup line lists it. */
export const REHEARSAL_DISABLED = "notification producers (backup, service, HA alerts) not started; urgent notifications not spoken";
/** What CORE_REHEARSAL keeps running; the startup line lists it too. */
export const REHEARSAL_KEPT = "Claude login check still runs (this Core's own login, not reported by the live Core)";

/** A notification producer as index.ts starts it. */
export interface StartableProducer {
  start(): void;
}

/**
 * Starts the notification producers, or none in rehearsal (one warn line,
 * journal-visible, naming what is off and what still runs). `always` (the
 * Claude login check, T20) starts in both modes. An undefined entry (a
 * producer that is off, e.g. HA alerts without HA_URL) is skipped.
 */
export function startNotificationProducers(
  rehearsal: boolean,
  producers: ReadonlyArray<StartableProducer | undefined>,
  logger: Pick<Logger, "warn">,
  always: ReadonlyArray<StartableProducer | undefined> = [],
): void {
  if (rehearsal) {
    logger.warn(`[shadow-core] REHEARSAL mode (CORE_REHEARSAL on): ${REHEARSAL_DISABLED}; ${REHEARSAL_KEPT}; the inbox still works`);
  } else {
    for (const p of producers) p?.start();
  }
  for (const p of always) p?.start();
}

/**
 * The `welcome.features` entry announcing rehearsal: `rehearsal` while the flag
 * is on (clients show a "prova" band), nothing otherwise (docs/02 "Features").
 */
export function rehearsalFeatures(rehearsal: boolean): ProtocolFeature[] {
  return rehearsal ? ["rehearsal"] : [];
}
