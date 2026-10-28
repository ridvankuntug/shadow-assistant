import { useState } from "react";
import type { ServiceHealth } from "../protocol/types.ts";
import { formatTime } from "./strings.ts";
import { issuesSummary, serviceIssues, serviceLabel, serviceReason } from "./serviceHealth.ts";

/**
 * Compact topbar indicator: nothing while every service is ok; otherwise a
 * 44 px tap target with a coloured dot and count that opens the reasons.
 */
export function ServiceIndicator({ services }: { services: readonly ServiceHealth[] }) {
  const issues = serviceIssues(services);
  const [open, setOpen] = useState(false);

  if (!issues) {
    // Everything recovered: close the list so it does not pop up again with
    // the next problem (state adjusted during render, no effect needed).
    if (open) setOpen(false);
    return null;
  }
  const summary = issuesSummary(issues);

  return (
    <div className="svc">
      <button
        type="button"
        className={`btn btn-icon svc-btn svc-${issues.level}`}
        aria-label={`Servis sorunu: ${summary}`}
        aria-expanded={open}
        aria-controls="svc-list"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="svc-dot" aria-hidden="true" />
        <span className="svc-count" aria-hidden="true">
          {issues.items.length}
        </span>
      </button>
      {open && (
        <ul id="svc-list" className="svc-list" role="status">
          {issues.items.map((s) => (
            <li key={s.name} className={`svc-item svc-${s.status}`}>
              <span className="svc-dot" aria-hidden="true" />
              <span>
                <strong>{serviceLabel(s.name)}</strong> {serviceReason(s)}
                {s.checkedAt > 0 && <small> · {formatTime(s.checkedAt)}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
