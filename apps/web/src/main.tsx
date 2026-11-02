import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { desktop } from "./desktop.ts";
import { applyAppearance, readSettings, subscribeSettings } from "./settings/settings.ts";
import { applyTheme, onSystemSchemeChange } from "./theme/apply.ts";
import "./index.css";

if (desktop) document.documentElement.dataset.platform = desktop.platform;
const showAppearance = () => {
  const { settings } = readSettings();
  applyAppearance(settings);
  applyTheme(settings.theme);
};
showAppearance();
subscribeSettings(showAppearance);
onSystemSchemeChange(showAppearance);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
