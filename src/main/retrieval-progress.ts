import type { AIActivity } from "../shared/ai-progress";
import type { SearchContextQuery } from "../shared/context-query";
import type { ContextQueryResult } from "./context-repository";

/** Facts from the host's bounded query, never model-authored execution claims. */
export function searchProgress(
  id: string,
  query: SearchContextQuery,
  chinese: boolean,
  result?: ContextQueryResult,
  listName?: string,
): AIActivity {
  const entity = chinese
    ? { tasks: "任务", memos: "资料", schedule: "日程" }[query.entity]
    : { tasks: "tasks", memos: "records", schedule: "schedule" }[query.entity];
  const scope: string[] = [];
  if (query.keywords)
    scope.push(
      chinese
        ? `关键词「${query.keywords.slice(0, 200)}」`
        : `Keywords: ${query.keywords.slice(0, 200)}`,
    );
  if (query.status)
    scope.push(
      chinese
        ? { todo: "未完成", done: "已完成", all: "全部状态" }[query.status]
        : `Status: ${query.status}`,
    );
  if (query.list_id)
    scope.push(listName || (chinese ? "指定清单" : "Selected list"));
  if (query.from || query.to)
    scope.push(`${query.from || "…"} — ${query.to || "…"}`);
  if (!scope.length)
    scope.push(chinese ? "未限定关键词或日期" : "No keyword or date filter");
  if (result) {
    scope.push(
      chinese
        ? `找到 ${result.total} 条，返回 ${result.returned} 条`
        : `${result.total} matches, ${result.returned} returned`,
    );
    if (result.offset || result.hasMore)
      scope.push(
        chinese
          ? result.returned
            ? `本页第 ${result.offset + 1}–${result.offset + result.returned} 条`
            : "本页无结果"
          : result.returned
            ? `Rows ${result.offset + 1}–${result.offset + result.returned}`
            : "Empty page",
      );
    if (query.entity === "memos")
      scope.push(chinese ? "原图与文件按需读取" : "Originals read on demand");
  }
  return {
    type: "activity",
    id,
    phase: "context",
    status: result ? "completed" : "running",
    label: chinese
      ? `${result ? "已搜索" : "正在搜索"}${entity}`
      : `${result ? "Searched" : "Searching"} ${entity}`,
    detail: scope.join(" · "),
  };
}
