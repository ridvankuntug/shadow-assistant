import type { ReactNode } from "react";

/**
 * A persistent, non-dismissable one-line band at the top of the chat area
 * (T11.5 "prova"). It informs, it does not alarm: `role="status"`, muted
 * colours. `tone` picks the colour so other states can reuse it later.
 */
export function Band({ tone = "info", children }: { tone?: "info"; children: ReactNode }) {
  return (
    <div className={`band band-${tone}`} role="status">
      {children}
    </div>
  );
}
