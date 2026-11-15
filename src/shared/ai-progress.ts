/** Public execution facts only. Never forward Codex reasoning or raw schema JSON. */
export type AIActivityPhase =
  "context" | "connection" | "model" | "response" | "validation";
export interface AIActivity {
  type: "activity";
  id: string;
  phase: AIActivityPhase;
  status: "running" | "completed";
  label: string;
  detail?: string;
  /** Public assistant response only, never reasoning or tool payloads. */
  text?: string;
}
export interface AIResponsePreview {
  type: "response";
  roundId?: string;
  /** Cumulative, unconfirmed answer text. The validated final reply replaces it. */
  text: string;
}
export type AIProgress = string | AIActivity | AIResponsePreview;
const labels: Record<AIActivityPhase, string> = {
  context: "读取任务上下文",
  connection: "连接 Codex",
  model: "处理请求",
  response: "生成回复",
  validation: "校验结果",
};
const clean = (text: string, limit: number) =>
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, limit);

export function aiActivity(
  phase: AIActivityPhase,
  status: AIActivity["status"],
  detail?: string,
): AIActivity {
  return {
    type: "activity",
    id: phase,
    phase,
    status,
    label: labels[phase],
    ...(detail ? { detail: clean(detail, 240) } : {}),
  };
}

/** Validate the remote helper's public progress envelope before forwarding it. */
export function parseAIProgress(
  value: unknown,
): Exclude<AIProgress, string> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type === "response" && typeof v.text === "string")
    return { type: "response", text: clean(v.text, 2000) };
  if (
    v.type !== "activity" ||
    typeof v.phase !== "string" ||
    !Object.hasOwn(labels, v.phase) ||
    v.id !== v.phase ||
    (v.status !== "running" && v.status !== "completed")
  )
    return null;
  return aiActivity(
    v.phase as AIActivityPhase,
    v.status,
    typeof v.detail === "string" ? v.detail : undefined,
  );
}

/** Decode only a top-level summary string, including a safe partial JSON string.
 * This does not authorize actions; the complete response still needs schema validation.
 */
export function responseSummary(raw: string): string {
  const text = raw.trimStart();
  if (!text.startsWith("{")) return "";
  const readString = (
    start: number,
  ): { value: string; end: number; closed: boolean } => {
    let value = "",
      index = start + 1;
    for (; index < text.length; index++) {
      const ch = text[index];
      if (ch === '"') return { value, end: index + 1, closed: true };
      if (ch === "\\") {
        const next = text[++index];
        if (next === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-f]{4}$/i.test(hex)) break;
          value += String.fromCharCode(parseInt(hex, 16));
          index += 4;
        } else {
          const escapes: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
          };
          if (!next || !Object.hasOwn(escapes, next)) break;
          value += escapes[next];
        }
      } else {
        if (ch.charCodeAt(0) < 32) break;
        value += ch;
      }
    }
    return {
      value: value.replace(/[\ud800-\udbff]$/, ""),
      end: index,
      closed: false,
    };
  };
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === '"') {
      const token = readString(index);
      if (!token.closed) return "";
      index = token.end - 1;
      if (depth === 1 && token.value === "summary") {
        let cursor = token.end;
        while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
        if (text[cursor++] !== ":") continue;
        while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
        if (text[cursor] !== '"') return "";
        return clean(readString(cursor).value, 2000);
      }
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return "";
}

export class CodexProgressTracker {
  private states = new Map<AIActivityPhase, AIActivity["status"]>();
  private preview = "";
  constructor(private readonly emit: (progress: AIProgress) => void) {}
  activity(
    phase: AIActivityPhase,
    status: AIActivity["status"],
    detail?: string,
  ) {
    if (this.states.get(phase) === status) return;
    this.states.set(phase, status);
    this.emit(aiActivity(phase, status, detail));
  }
  summary(raw: string, _complete = false) {
    const text = responseSummary(raw);
    if (!text || text === this.preview) return;
    this.preview = text;
    this.emit({ type: "response", text });
  }
  consume(event: Record<string, any>) {
    if (event.type === "thread.started")
      this.activity("connection", "completed");
    if (event.type === "turn.started") {
      this.activity("connection", "completed");
      this.activity("model", "running");
    }
    // Deliberately ignore reasoning, tool payloads, unknown events and their contents.
    if (
      ["item.started", "item.updated", "item.completed"].includes(event.type) &&
      event.item?.type === "agent_message"
    ) {
      this.activity("response", "running");
      if (typeof event.item.text === "string")
        this.summary(event.item.text, event.type === "item.completed");
      if (event.type === "item.completed")
        this.activity("response", "completed");
    }
    if (event.type === "turn.completed") this.activity("model", "completed");
  }
}
