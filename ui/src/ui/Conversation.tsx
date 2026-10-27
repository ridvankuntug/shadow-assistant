import { useEffect, useRef } from "react";
import type { ChatMessage } from "../assistant/state.ts";
import { toolStatusText } from "./strings.ts";

function messageText(m: ChatMessage): string {
  if (m.role === "user" && !m.text) {
    return m.pending ? "Ses çözümleniyor…" : m.failed ? "(ses anlaşılamadı)" : "";
  }
  if (m.role === "assistant" && !m.text && m.pending) return "…";
  return m.text;
}

export function Conversation({ messages }: { messages: ChatMessage[] }) {
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, last?.text]);

  if (messages.length === 0) {
    return (
      <div className="conversation conversation-empty">
        <p>Konuşmak için mikrofona basılı tut ya da aşağıya yaz.</p>
      </div>
    );
  }

  return (
    <div className="conversation" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map((m) => (
        <article
          key={m.key}
          className={`msg msg-${m.role}${m.pending ? " msg-pending" : ""}${m.failed ? " msg-failed" : ""}`}
        >
          {m.tools.length > 0 && (
            <ul className="tools" aria-label="Araçlar">
              {m.tools.map((t) => (
                <li key={t.name} className={`tool tool-${t.status}`}>
                  {t.name} · {toolStatusText(t.status)}
                </li>
              ))}
            </ul>
          )}
          <p>{messageText(m)}</p>
          {m.cancelled && <p className="msg-note">Yarıda kesildi</p>}
          {m.failed && m.role === "assistant" && <p className="msg-note">Tamamlanamadı</p>}
        </article>
      ))}
      <div ref={end} />
    </div>
  );
}
