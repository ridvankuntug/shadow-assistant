import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { canPreviewVoice, canStop, currentConfirm, derivePhase } from "./assistant/state.ts";
import type { AssistantController } from "./assistant/controller.ts";
import { STORAGE_KEYS, type PlatformAdapter } from "./platform/types.ts";
import { PHASE_COLOR } from "./scene/phaseStyle.ts";
import { resolveQuality, type Quality } from "./scene/quality.ts";
import { ConfirmCard } from "./ui/ConfirmCard.tsx";
import { Composer } from "./ui/Composer.tsx";
import { ConnectScreen } from "./ui/ConnectScreen.tsx";
import { Conversation } from "./ui/Conversation.tsx";
import { HistoryPanel, SettingsPanel } from "./ui/Panels.tsx";
import { ServiceIndicator } from "./ui/ServiceIndicator.tsx";
import { sttStatus } from "./ui/serviceHealth.ts";
import { VoicePicker } from "./ui/VoicePicker.tsx";
import { Stage } from "./ui/Stage.tsx";
import { CONNECTION_LABEL, noticeText, resolvedText } from "./ui/strings.ts";

type Props = { adapter: PlatformAdapter; controller: AssistantController };

type Panel = "none" | "history" | "settings" | "connect";

export default function App({ adapter, controller }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const phase = derivePhase(state);
  const confirm = currentConfirm(state);

  const visible = useSyncExternalStore(
    useCallback((cb: () => void) => adapter.onVisibilityChange(cb), [adapter]),
    () => adapter.isVisible(),
  );
  const reducedMotion = useMemo(() => adapter.prefersReducedMotion(), [adapter]);

  const [coreUrl, setCoreUrl] = useState(() => adapter.storage.get(STORAGE_KEYS.coreUrl) ?? "");
  const [token, setToken] = useState(() => adapter.storage.get(STORAGE_KEYS.token) ?? "");
  const [quality, setQuality] = useState<Quality>(() =>
    resolveQuality(adapter.storage.get(STORAGE_KEYS.quality), adapter.deviceClass()),
  );
  const [voiceReplies, setVoiceReplies] = useState(() => adapter.storage.get(STORAGE_KEYS.voiceReplies) !== "0");
  // Voice choice only matters where the Core speaks (web); Android speaks natively.
  const coreTts = adapter.tts.mode === "core";
  const [voice, setVoice] = useState<string | null>(() => adapter.storage.get(STORAGE_KEYS.ttsVoice) || null);
  const [panel, setPanel] = useState<Panel>("none");
  const closePanel = useCallback(() => setPanel("none"), []);

  // Connect on start when a configuration is stored; reconnect when it changes.
  useEffect(() => {
    if (!coreUrl || !token) return;
    controller.connect(coreUrl, token);
    return () => controller.disconnect();
  }, [controller, coreUrl, token]);

  useEffect(() => {
    controller.setVoiceReplies(voiceReplies);
  }, [controller, voiceReplies]);

  useEffect(() => {
    controller.setVoice(coreTts ? voice : null);
  }, [controller, coreTts, voice]);

  // The settings panel needs the voice list: ask when it is open and none is
  // loaded (also after a reconnect, which resets the list).
  const voicesStatus = state.voices.status;
  const connectedNow = state.connection.status === "connected";
  useEffect(() => {
    if (coreTts && panel === "settings" && connectedNow && voicesStatus === "idle") controller.requestVoices();
  }, [controller, coreTts, panel, connectedNow, voicesStatus]);

  // Back in the foreground: skip the remaining reconnect backoff. Visibility
  // never touches a recording here: in a browser tab it keeps running while
  // hidden, and on Android the permission dialog pauses the activity too, so
  // stopping a recording on pause is the shell's job.
  useEffect(() => {
    if (!visible) return;
    controller.resume();
  }, [controller, visible]);

  useEffect(() => () => controller.dispose(), [controller]);

  const level = useCallback(() => Math.max(adapter.mic.level(), adapter.playback.level()), [adapter]);

  const saveConnection = (url: string, newToken: string) => {
    adapter.storage.set(STORAGE_KEYS.coreUrl, url);
    adapter.storage.set(STORAGE_KEYS.token, newToken);
    setCoreUrl(url);
    setToken(newToken);
    setPanel("none");
    // Same values again (e.g. after "unauthorized"): the effect will not
    // re-run, so reconnect explicitly.
    if (url === coreUrl && newToken === token) controller.connect(url, newToken);
  };

  const changeQuality = (q: Quality) => {
    adapter.storage.set(STORAGE_KEYS.quality, q);
    setQuality(q);
  };

  const changeVoice = (v: string | null) => {
    if (v) adapter.storage.set(STORAGE_KEYS.ttsVoice, v);
    else adapter.storage.remove(STORAGE_KEYS.ttsVoice);
    setVoice(v);
  };

  const openSettings = () => {
    // Retry a list that could not be fetched last time.
    if (coreTts && state.voices.status === "unavailable") controller.requestVoices();
    setPanel("settings");
  };

  const changeVoiceReplies = (v: boolean) => {
    adapter.storage.set(STORAGE_KEYS.voiceReplies, v ? "1" : "0");
    setVoiceReplies(v);
    if (!v) controller.stopSpeaking();
  };

  const status = state.connection.status;
  const unauthorized = status === "unauthorized";

  if (!coreUrl || !token || unauthorized || panel === "connect") {
    return (
      <ConnectScreen
        initialUrl={coreUrl}
        initialToken={token}
        error={unauthorized ? noticeText("unauthorized") : undefined}
        onSubmit={saveConnection}
        onCancel={coreUrl && token && !unauthorized ? () => setPanel("none") : undefined}
      />
    );
  }

  const connected = status === "connected";
  const notice = state.notice;
  const accent = PHASE_COLOR[phase];

  return (
    <div className={`app phase-${phase}`} style={{ "--accent": accent } as CSSProperties}>
      <header className="topbar">
        <span className="brand">SHADOW</span>
        <span className={`conn conn-${status}`} role="status">
          <span className="conn-dot" aria-hidden="true" />
          {CONNECTION_LABEL[status]}
          {status === "reconnecting" && state.connection.retryInMs !== undefined && (
            <> · {Math.ceil(state.connection.retryInMs / 1000)} sn içinde yeniden denenecek</>
          )}
        </span>
        <nav className="topbar-actions">
          {/* Only while connected: after a disconnect the last list is stale. */}
          {connected && <ServiceIndicator services={state.services} />}
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Son konuşmalar"
            onClick={() => {
              controller.requestHistory();
              setPanel("history");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3Zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12Z" />
            </svg>
          </button>
          <button type="button" className="btn btn-icon" aria-label="Ayarlar" onClick={openSettings}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1L11 21h4l.4-2.9a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5L19.4 13ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
            </svg>
          </button>
        </nav>
      </header>

      <Stage phase={phase} quality={quality} active={visible} reducedMotion={reducedMotion} level={level} />

      <section className="chat" aria-label="Konuşma">
        <Conversation messages={state.messages} />

        {notice && (
          <div className="notice" role="alert">
            <p>{noticeText(notice.code, notice.message)}</p>
            <button type="button" className="btn btn-ghost" onClick={() => controller.dismissNotice()}>
              Tamam
            </button>
          </div>
        )}
        {status === "incompatible" && (
          <div className="notice" role="alert">
            <p>{noticeText("incompatible")}</p>
          </div>
        )}
        {status === "reconnecting" && (
          <div className="notice notice-soft">
            <p>Çekirdeğe ulaşılamıyor.</p>
            <button type="button" className="btn btn-ghost" onClick={() => controller.resume()}>
              Şimdi dene
            </button>
          </div>
        )}
        {!confirm && state.lastResolved && (
          <p className="resolved" key={state.lastResolved.requestId} role="status">
            {resolvedText(state.lastResolved.approved, state.lastResolved.by)}
          </p>
        )}
        {confirm && <ConfirmCard key={confirm.requestId} confirm={confirm} onAnswer={(a) => controller.respondConfirm(a)} />}

        <Composer
          phase={phase}
          capture={state.capture}
          connected={connected}
          canStop={canStop(state)}
          stt={sttStatus(state.services)}
          onSendText={(t) => controller.sendText(t)}
          onTalkStart={() => void controller.startTalk()}
          onTalkStop={() => void controller.stopTalk()}
          onStop={() => controller.stop()}
        />
      </section>

      {panel === "history" && (
        <HistoryPanel
          items={state.history}
          loaded={state.historyLoaded}
          connected={connected}
          onRefresh={() => controller.requestHistory()}
          onClose={closePanel}
        />
      )}
      {panel === "settings" && (
        <SettingsPanel
          quality={quality}
          voiceReplies={voiceReplies}
          reducedMotion={reducedMotion}
          coreUrl={coreUrl}
          voicePicker={
            coreTts ? (
              <VoicePicker
                catalog={state.voices}
                chosen={voice}
                connected={connected}
                canPreview={canPreviewVoice(state)}
                preview={state.voicePreview}
                awaitingSpeech={state.awaitingSpeech}
                playing={state.playing}
                onChange={changeVoice}
                onPreview={(v) => controller.previewVoice(v)}
                onRetry={() => controller.requestVoices()}
              />
            ) : undefined
          }
          onQuality={changeQuality}
          onVoiceReplies={changeVoiceReplies}
          onChangeConnection={() => setPanel("connect")}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
