import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AssistantController } from "./assistant/controller.ts";
import type { AndroidWindow } from "./platform/android.ts";
import { selectAdapter } from "./platform/select.ts";
import { createWebAdapter } from "./platform/web.ts";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

const { adapter } = selectAdapter(window as unknown as AndroidWindow, { web: createWebAdapter });
const controller = new AssistantController({ adapter, clientVersion: __APP_VERSION__ });

createRoot(rootElement).render(
  <StrictMode>
    <App adapter={adapter} controller={controller} />
  </StrictMode>,
);
