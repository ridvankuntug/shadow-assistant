/**
 * The user message of one model turn ("turn envelope", docs/07 §Tier switching)
 * and the fixed texts that go into it. Provider-neutral and dependency-free:
 * imported by session.ts (which must never load a provider SDK) and agent.ts.
 */

/**
 * First line of an escalatable tier-1 user message. `prompts/tier1.md` is
 * written conditionally on it, so one static system prompt serves every tier
 * (persistent mode) and the escalation rule applies only to marked messages.
 */
export const TIER1_MARKER = "[mod:hizli]";

/** Prompt for the stronger model when the cheap one escalated after running tools. */
export const ESCALATION_CONTINUE =
  "(Önceki adım bu isteği tamamlayamadı. Yukarıdaki araç sonuçlarını kullan, başarılı olmuş işlemleri tekrarlama ve kullanıcının son isteğini tamamla.)";

/**
 * Delimiters of the tier-0 exchange records the model did not see
 * (`system.md`: never answer what is between them; answer the request after
 * them). They keep the records apart from a question in the same message.
 */
export const DIRECT_NOTES_START = "<bilgi>";
export const DIRECT_NOTES_END = "</bilgi>";

/** Wraps tier-0 exchange records (`Kullanıcı: … / Shadow: …`) in the delimiters; "" when there are none. */
export function wrapDirectNotes(notes: readonly string[]): string {
  const body = notes.map((n) => n.trim()).filter((n) => n !== "");
  if (body.length === 0) return "";
  return [DIRECT_NOTES_START, ...body, DIRECT_NOTES_END].join("\n");
}

/**
 * The user message of one model turn: the tier-1 marker line (escalatable
 * turns only), delimited tier-0 records, an optional memory block (docs/06),
 * then the user's text.
 */
export function buildTurnEnvelope(e: { text: string; escalatable?: boolean; notes?: readonly string[]; memoryBlock?: string }): string {
  const parts: string[] = [];
  if (e.escalatable) parts.push(TIER1_MARKER);
  const notes = wrapDirectNotes(e.notes ?? []);
  if (notes) parts.push(notes);
  if (e.memoryBlock?.trim()) parts.push(e.memoryBlock.trim());
  parts.push(e.text);
  return parts.join("\n");
}
