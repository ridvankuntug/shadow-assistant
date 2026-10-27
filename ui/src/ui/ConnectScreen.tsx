import { useId, useState, type FormEvent } from "react";
import { normalizeCoreUrl } from "../protocol/client.ts";

export const DEFAULT_CORE_URL = "ws://localhost:8700/ws";

type Props = {
  initialUrl: string;
  initialToken: string;
  /** Shown above the form, e.g. after the Core rejected the token. */
  error?: string;
  onSubmit: (url: string, token: string) => void;
  onCancel?: () => void;
};

/** Core URL + device token entry. Values are persisted by the caller through the adapter. */
export function ConnectScreen({ initialUrl, initialToken, error, onSubmit, onCancel }: Props) {
  const [url, setUrl] = useState(initialUrl || DEFAULT_CORE_URL);
  const [token, setToken] = useState(initialToken);
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const urlId = useId();
  const tokenId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeCoreUrl(url);
    if (!normalized) {
      setFormError("Geçerli bir adres gir (ör. ws://localhost:8700/ws).");
      return;
    }
    if (!token.trim()) {
      setFormError("Cihaz anahtarı gerekli.");
      return;
    }
    setFormError(null);
    onSubmit(normalized, token.trim());
  };

  return (
    <main className="connect">
      <form className="connect-card" onSubmit={submit} noValidate>
        <h1 className="brand">SHADOW</h1>
        <p className="connect-lead">Çekirdeğe bağlanmak için adresini ve bu cihazın anahtarını gir.</p>
        {(error || formError) && (
          <p className="form-error" role="alert">
            {formError ?? error}
          </p>
        )}
        <label htmlFor={urlId}>Çekirdek adresi</label>
        <input
          id={urlId}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={DEFAULT_CORE_URL}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <label htmlFor={tokenId}>Cihaz anahtarı</label>
        <div className="token-row">
          <input
            id={tokenId}
            type={showToken ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={showToken}
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? "Gizle" : "Göster"}
          </button>
        </div>
        <p className="hint">Anahtar yalnızca bu cihazda saklanır.</p>
        <div className="connect-actions">
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Vazgeç
            </button>
          )}
          <button type="submit" className="btn btn-primary">
            Bağlan
          </button>
        </div>
      </form>
    </main>
  );
}
