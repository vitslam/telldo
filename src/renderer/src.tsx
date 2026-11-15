import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "./polish.css";
import "./themes.css";
import "./task-detail.css";
const isMac = window.telldo.platform === "darwin";
document.documentElement.dataset.platform = window.telldo.platform;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isMac && <div className="window-titlebar" aria-hidden="true" />}
    <App />
  </React.StrictMode>,
);
