import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "./polish.css";
import "./themes.css";
import "./task-detail.css";
import "./focus.css";
// Modal focus restoration inherits Chromium's focus-visible state. Track the
// actual input method so returning from a mouse-opened dialog leaves no ring.
document.documentElement.dataset.focusInput = "pointer";
document.addEventListener("pointerdown", () => {
  document.documentElement.dataset.focusInput = "pointer";
}, true);
document.addEventListener("keydown", event => {
  if (event.key === "Tab") document.documentElement.dataset.focusInput = "keyboard";
}, true);
const isMac = window.telldo.platform === "darwin";
document.documentElement.dataset.platform = window.telldo.platform;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isMac && <div className="window-titlebar" aria-hidden="true" />}
    <App />
  </React.StrictMode>,
);
