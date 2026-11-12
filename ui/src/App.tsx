import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  canPreviewVoice,
  canStop,
  currentConfirm,
  derivePhase,
  devAvailable,
  devBadgeCount,
  hasFeature,
  memoryAvailable,
  notificationsAvailable,
  notificationsBadgeCount,
  notificationsUnavailable,
} from "./assistant/state.ts";
import type { AssistantController } from "./assistant/controller.ts";
import { STORAGE_KEYS, type PlatformAdapter } from "./platform/types.ts";
import { PHASE_COLOR } from "./scene/phaseStyle.ts";
import { resolveQuality, type Quality } from "./scene/quality.ts";
import { ConfirmCard } from "./ui/ConfirmCard.tsx";
import { Composer } from "./ui/Composer.tsx";
import { ConnectScreen } from "./ui/ConnectScreen.tsx";
import { Conversation } from "./ui/Conversation.tsx";
import { DevPanel } from "./ui/DevPanel.tsx";
import { MemoryPanel } from "./ui/MemoryPanel.tsx";
import { NotificationsPanel } from "./ui/NotificationsPanel.tsx";
import { HistoryPanel, SettingsPanel } from "./ui/Panels.tsx";
import { ServiceIndicator } from "./ui/ServiceIndicator.tsx";
import { sttStatus } from "./ui/serviceHealth.ts";
import { clearTrayHash, trayTarget, watchTrayHash } from "./ui/trayHash.ts";
import { VoicePicker } from "./ui/VoicePicker.tsx";
import { Stage } from "./ui/Stage.tsx";
import { CONNECTION_LABEL, devOpenText, noticeMessage, noticeText, notificationsUnreadText, resolvedText } from "./ui/strings.ts";

type Props = { adapter: PlatformAdapter; controller: AssistantController };

type Panel = "none" | "history" | "settings" | "memory" | "dev" | "notifications" | "connect";

/** The tray opens the UI at `#dev` / `#notifications` (docs/08 §T7.w.4, §T7.w.5; ui/trayHash.ts). */
const atHash = (panel: "dev" | "notifications") => typeof window !== "undefined" && trayTarget(window.location.hash) === panel;
const atDevHash = () => atHash("dev");
const atNotificationsHash = () => atHash("notifications");

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
  // The Core speaks on every host (single voice), so the voice choice applies everywhere.
  const [voice, setVoice] = useState<string | null>(() => adapter.storage.get(STORAGE_KEYS.ttsVoice) || null);
  const [panel, setPanel] = useState<Panel>("none");
  const closePanel = useCallback(() => setPanel("none"), []);
  const backToSettings = useCallback(() => setPanel("settings"), []);
  // Where closing the Development panel returns to (it opens from Settings or the badge).
  const [devFrom, setDevFrom] = useState<"none" | "settings">("none");
  const closeDev = useCallback(() => setPanel(devFrom), [devFrom]);
  // `#dev` asked for the Development panel; it opens once the Core offers it.
  const [devWanted, setDevWanted] = useState(atDevHash);
  // `#notifications` asked for the inbox; it opens once the Core offers it.
  const [notificationsWanted, setNotificationsWanted] = useState(atNotificationsHash);

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
    controller.setVoice(voice);
  }, [controller, voice]);

  // The settings panel needs the voice list: ask when it is open and none is
  // loaded (also after a reconnect, which resets the list).
  const voicesStatus = state.voices.status;
  const connectedNow = state.connection.status === "connected";
  useEffect(() => {
    if (panel === "settings" && connectedNow && voicesStatus === "idle") controller.requestVoices();
  }, [controller, panel, connectedNow, voicesStatus]);

  // The memory panel asks for the contents each time it opens, and again
  // after a reconnect (the welcome resets them).
  const memoryOn = memoryAvailable(state);
  useEffect(() => {
    if (panel === "memory" && memoryOn) controller.requestMemory();
  }, [controller, panel, memoryOn]);
  // Leaving the panel (closed, or replaced by another one, e.g. through
  // `#dev`) abandons its request: a late answer must not change anything.
  useEffect(() => {
    if (panel !== "memory") return;
    return () => controller.closeMemory();
  }, [controller, panel]);

  // The Development panel asks for the items each time it opens, and again
  // after a reconnect (the welcome resets them).
  const devOn = devAvailable(state);
  useEffect(() => {
    if (panel === "dev" && devOn) controller.requestDev();
  }, [controller, panel, devOn]);

  // The inbox asks for the list each time it opens (the badge comes from the
  // list sent after welcome and the broadcasts).
  const notificationsOn = notificationsAvailable(state);
  useEffect(() => {
    if (panel === "notifications" && notificationsOn) controller.requestNotifications();
  }, [controller, panel, notificationsOn]);

  // The open panel for the hash listener (a hash for the open panel is dropped there).
  const panelRef = useRef<Panel>(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);
  useEffect(
    () =>
      watchTrayHash(
        window,
        () => panelRef.current,
        (target) => (target === "dev" ? setDevWanted(true) : setNotificationsWanted(true)),
      ),
    [],
  );
  // Drop a consumed `#dev` / `#notifications` once its panel opens, so the tray can target it again in this tab.
  useEffect(() => {
    clearTrayHash(window, panel);
  }, [panel]);
  // Open it once the Core offers it (state adjusted during render, no effect needed).
  if (devWanted && devOn) {
    setDevWanted(false);
    setDevFrom("none");
    setPanel("dev");
  }
  if (notificationsWanted && notificationsOn) {
    setNotificationsWanted(false);
    setPanel("notifications");
  }

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
    if (state.voices.status === "unavailable") controller.requestVoices();
    setPanel("settings");
  };

  const changeVoiceReplies = (v: boolean) => {
    adapter.storage.set(STORAGE_KEYS.voiceReplies, v ? "1" : "0");
    setVoiceReplies(v);
    if (!v) controller.stopSpeaking();
  };

  const openDev = (from: "none" | "settings") => {
    setDevFrom(from);
    setPanel("dev");
  };
  // Gemini hand-off (T15): only where the host can open it (the Android shell); never in a browser.
  const openGemini = adapter.openGemini;
  const handOffToGemini = (open: () => void) => {
    // Leave nothing listening or speaking behind; the running turn's text still arrives.
    controller.leaveForOtherApp();
    open();
  };

  const devCount = devBadgeCount(state);
  const unreadCount = notificationsBadgeCount(state);
  const inboxUnreadable = notificationsUnavailable(state);

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
          {/* Development badge: a count only, never a notification or a sound. */}
          {devCount > 0 && (
            <button
              type="button"
              className="btn btn-icon dev-badge"
              aria-label={`Geliştirme: ${devOpenText(devCount)}`}
              onClick={() => openDev("none")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z" />
              </svg>
              <span className="dev-count" aria-hidden="true">
                {devCount > 99 ? "99+" : devCount}
              </span>
            </button>
          )}
          {/* Inbox: always reachable with the Core feature; the count only while something is unread. */}
          {notificationsOn && (
            <button
              type="button"
              className="btn btn-icon notifications-badge"
              aria-label={
                inboxUnreadable
                  ? "Bildirimler: okunamadı"
                  : unreadCount > 0
                    ? `Bildirimler: ${notificationsUnreadText(unreadCount)}`
                    : "Bildirimler"
              }
              onClick={() => setPanel("notifications")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 0 0-4.5-5.8V4.5a1.5 1.5 0 0 0-3 0v.7A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2Z" />
              </svg>
              {/* "!" while the Core cannot read its notifications file (the count is then unknown). */}
              {inboxUnreadable ? (
                <span className="dev-count" aria-hidden="true">
                  !
                </span>
              ) : (
                unreadCount > 0 && (
                  <span className="dev-count" aria-hidden="true">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )
              )}
            </button>
          )}
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
          {/* Rightmost, in the corner. A plain sparkle, not Google's logo. */}
          {openGemini && (
            <button
              type="button"
              className="btn btn-icon gemini-btn"
              aria-label="Gemini'yi aç"
              title="Gemini'yi aç"
              onClick={() => handOffToGemini(openGemini)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z" />
              </svg>
            </button>
          )}
        </nav>
      </header>

      <Stage phase={phase} quality={quality} active={visible} reducedMotion={reducedMotion} level={level} />

      <section className="chat" aria-label="Konuşma">
        <Conversation messages={state.messages} />

        {notice && (
          <div className="notice" role="alert">
            <p>{noticeMessage(notice)}</p>
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
          }
          onOpenMemory={memoryOn ? () => setPanel("memory") : undefined}
          onOpenDev={devOn ? () => openDev("settings") : undefined}
          devOpen={devCount}
          onQuality={changeQuality}
          onVoiceReplies={changeVoiceReplies}
          onChangeConnection={() => setPanel("connect")}
          onClose={closePanel}
        />
      )}
      {panel === "memory" && (
        <MemoryPanel
          memory={state.memory}
          connected={connected}
          available={hasFeature(state, "memory")}
          onRefresh={() => controller.requestMemory()}
          onDelete={(entryId) => controller.deleteMemoryEntry(entryId)}
          onClose={backToSettings}
        />
      )}
      {/* Hidden without the Core feature `dev` (e.g. after reconnecting to an older Core). */}
      {panel === "dev" && hasFeature(state, "dev") && (
        <DevPanel
          dev={state.dev}
          connected={connected}
          onRefresh={() => controller.requestDev()}
          onAction={(itemId, action) => controller.devAction(itemId, action)}
          onClose={closeDev}
        />
      )}
      {/* Hidden without the Core feature `notifications`. */}
      {panel === "notifications" && hasFeature(state, "notifications") && (
        <NotificationsPanel
          notifications={state.notifications}
          connected={connected}
          onRefresh={() => controller.requestNotifications()}
          onAction={(id, action) => controller.notificationAction(id, action)}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
