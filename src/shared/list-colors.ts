// Shared by manual creation and AI proposals; explicit user colors are preserved.
export const LIST_COLORS = [
  { color: "#6d74e8", name: "Indigo", zh: "靛蓝" },
  { color: "#36a18b", name: "Jade", zh: "青绿" },
  { color: "#c99442", name: "Amber", zh: "琥珀" },
  { color: "#b77cad", name: "Mauve", zh: "木槿" },
  { color: "#5c99bb", name: "Sky", zh: "天蓝" },
  { color: "#cd8270", name: "Terracotta", zh: "陶红" },
  { color: "#8b9c59", name: "Olive", zh: "橄榄" },
  { color: "#9b83cc", name: "Lavender", zh: "薰紫" },
  { color: "#cf889e", name: "Rose", zh: "蔷薇" },
  { color: "#529fa4", name: "Teal", zh: "湖青" },
  { color: "#b79a75", name: "Sand", zh: "砂岩" },
  { color: "#8192a6", name: "Slate", zh: "雾灰" },
] as const;

export function nextListColor(lists: readonly { color: string }[]): string {
  const counts = new Map<string, number>();
  for (const list of lists) {
    const color = list.color.toLowerCase();
    counts.set(color, (counts.get(color) || 0) + 1);
  }
  return LIST_COLORS.reduce((best, candidate) =>
    (counts.get(candidate.color) || 0) < (counts.get(best.color) || 0)
      ? candidate : best,
  ).color;
}
