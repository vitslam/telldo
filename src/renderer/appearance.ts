import type { Settings } from "../shared/types";
type Appearance = Pick<Settings, "theme" | "appearance">;
const system = window.matchMedia("(prefers-color-scheme: dark)");
export function applyAppearance(value: Appearance, persist = false) {
  const root = document.documentElement;
  root.dataset.theme = value.theme || "mono";
  root.dataset.appearance = value.appearance || "system";
  root.dataset.scheme =
    root.dataset.appearance === "system"
      ? system.matches
        ? "dark"
        : "light"
      : root.dataset.appearance;
  if (persist) {
    try {
      localStorage.setItem("telldo.appearance", JSON.stringify(value));
    } catch {}
  }
}
system.addEventListener("change", () => {
  if (document.documentElement.dataset.appearance === "system")
    document.documentElement.dataset.scheme = system.matches ? "dark" : "light";
});
try {
  applyAppearance(
    JSON.parse(localStorage.getItem("telldo.appearance") || "{}"),
  );
} catch {
  applyAppearance({ theme: "mono", appearance: "system" });
}
