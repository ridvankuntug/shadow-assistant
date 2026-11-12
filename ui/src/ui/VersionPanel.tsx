import type { AppInfo } from "../platform/types.ts";
import { Drawer } from "./Panels.tsx";
import { versionView } from "./versionInfo.ts";

/**
 * "Güncelleme ve sürüm" (T16.2), opened from the top bar menu. In the Android
 * app: the installed version and "Güncellemeleri denetle", which opens the
 * app's own update screen (the same one as the launcher shortcut). In a
 * browser there is no installed app, so the page says where this lives.
 */
export function VersionPanel({
  app,
  onCheckUpdates,
  onClose,
}: {
  app: AppInfo | undefined;
  /** Called instead of `app.openUpdates` directly, so the caller can stop listening/speaking first. */
  onCheckUpdates: (open: () => void) => void;
  onClose: () => void;
}) {
  const view = versionView(app);
  const openUpdates = view.kind === "app" ? view.openUpdates : undefined;
  return (
    <Drawer title="Güncelleme ve sürüm" onClose={onClose}>
      {view.kind === "browser" ? (
        <p className="hint">Sürüm bilgisi ve güncelleme denetimi yalnız Android uygulamasında var.</p>
      ) : (
        <>
          <dl className="version-info">
            <dt>Kurulu sürüm</dt>
            <dd>{view.name}</dd>
            <dt>Sürüm kodu</dt>
            <dd>{view.code}</dd>
          </dl>
          {openUpdates ? (
            <button type="button" className="btn btn-primary" onClick={() => onCheckUpdates(openUpdates)}>
              Güncellemeleri denetle
            </button>
          ) : (
            <p className="hint">Bu uygulama sürümü denetimi buradan açamıyor.</p>
          )}
          <p className="hint">
            Uygulama simgesine uzun basıp “Güncellemeleri denetle”yi seçerek de açabilirsin. Denetim yalnız sen
            istediğinde yapılır.
          </p>
        </>
      )}
    </Drawer>
  );
}
