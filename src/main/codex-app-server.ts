import type { SpawnProcess } from "./codex-adapter";
import type { CodexProgressTracker } from "../shared/ai-progress";
import { StringDecoder } from "node:string_decoder";

export const APP_SERVER_ARGS = [
  "app-server",
  "--disable",
  "shell_tool",
  "--disable",
  "hooks",
  "--disable",
  "apps",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
  "-c",
  "mcp_servers={}",
  "-c",
  'web_search="disabled"',
  "-c",
  "project_doc_max_bytes=0",
];
const MAX_OUTPUT = 2 * 1024 * 1024;
const TOOL_FAILURE =
  "Codex attempted a tool call. This request was rejected and no tasks were changed. / 检测到工具调用，本次请求已拒绝，任务未更改。";

/** Owned, ephemeral stdio app-server. No HTTP listener or shared daemon is used. */
export function runAppServer(options: {
  spawn: SpawnProcess;
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  schema: unknown;
  imagePaths: string[];
  timeoutMs: number;
  progress: CodexProgressTracker;
  registerAbort: (abort: (reason: Error) => void) => void;
  errorFor: (text: string) => Error;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = options.spawn(options.executable, [...APP_SERVER_ARGS], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let settled = false,
      buffer = "",
      stderr = "",
      total = 0;
    let threadId = "",
      turnId = "",
      finalMessage = "";
    const messages = new Map<string, string>();
    const decoder = new StringDecoder("utf8");
    const stop = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* owned process already gone */
        }
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(finalMessage);
    };
    const timer = setTimeout(
      () => finish(new Error("Codex timed out. / Codex 请求超时。")),
      Math.max(1, options.timeoutMs),
    );
    options.registerAbort((reason) => finish(reason));
    const send = (value: unknown) => {
      if (settled) return;
      try {
        child.stdin.write(JSON.stringify(value) + "\n");
      } catch {
        finish(
          new Error("Codex native connection failed. / Codex 原生连接失败。"),
        );
      }
    };
    const request = (id: number, method: string, params: unknown) =>
      send({ id, method, params });
    const invalid = () =>
      finish(
        new Error(
          "Codex returned an invalid native event stream. / Codex 返回了无效原生事件流。",
        ),
      );
    const active = (params: any) => {
      if (params.threadId !== threadId || !threadId) return false;
      if (params.turnId && turnId && params.turnId !== turnId) return false;
      return true;
    };
    const consume = (line: string) => {
      if (settled || !line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        invalid();
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        invalid();
        return;
      }
      if ("id" in event && typeof event.method === "string") {
        // The app has no interactive/tool handlers. Deny and terminate any server request.
        send({
          id: event.id,
          error: {
            code: -32601,
            message: "Telldo does not permit native tool requests",
          },
        });
        finish(new Error(TOOL_FAILURE));
        return;
      }
      if ("id" in event) {
        if (event.error) {
          finish(
            options.errorFor(
              String(event.error?.message || "native request failed"),
            ),
          );
          return;
        }
        if (!event.result || typeof event.result !== "object") {
          invalid();
          return;
        }
        if (event.id === 1) {
          options.progress.activity("connection", "completed");
          send({ method: "initialized" });
          request(2, "thread/start", {
            cwd: options.cwd,
            sandbox: "read-only",
            approvalPolicy: "never",
            ephemeral: true,
            dynamicTools: [],
            environments: [],
            config: {
              mcp_servers: {},
              web_search: "disabled",
              project_doc_max_bytes: 0,
            },
          });
        } else if (event.id === 2) {
          threadId = event.result.thread?.id;
          if (typeof threadId !== "string" || !threadId) {
            invalid();
            return;
          }
          request(3, "turn/start", {
            threadId,
            cwd: options.cwd,
            approvalPolicy: "never",
            input: [
              { type: "text", text: options.prompt, text_elements: [] },
              ...options.imagePaths.map((path) => ({
                type: "localImage",
                path,
              })),
            ],
            outputSchema: options.schema,
          });
        } else if (event.id === 3) {
          const id = event.result.turn?.id;
          if (typeof id !== "string" || !id || (turnId && turnId !== id)) {
            invalid();
            return;
          }
          turnId = id;
          options.progress.activity("model", "running");
        }
        return;
      }
      if (
        typeof event.method === "string" &&
        /commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent|execCommand|applyPatch/.test(
          event.method,
        )
      ) {
        finish(new Error(TOOL_FAILURE));
        return;
      }
      const params = event.params || {};
      if (!active(params)) return;
      if (event.method === "turn/started") {
        const id = params.turn?.id;
        if (typeof id !== "string" || !id || (turnId && turnId !== id)) {
          invalid();
          return;
        }
        turnId = id;
        options.progress.activity("model", "running");
      } else if (event.method === "item/agentMessage/delta") {
        if (
          typeof params.itemId !== "string" ||
          typeof params.delta !== "string"
        ) {
          invalid();
          return;
        }
        finalMessage = "";
        const raw = (messages.get(params.itemId) || "") + params.delta;
        messages.set(params.itemId, raw);
        options.progress.activity("response", "running");
        options.progress.summary(raw);
      } else if (
        event.method === "item/started" ||
        event.method === "item/completed"
      ) {
        const item = params.item;
        if (!item || typeof item.type !== "string") {
          invalid();
          return;
        }
        if (
          ![
            "userMessage",
            "agentMessage",
            "reasoning",
            "plan",
            "contextCompaction",
          ].includes(item.type)
        ) {
          finish(new Error(TOOL_FAILURE));
          return;
        }
        if (item.type === "agentMessage") {
          if (typeof item.text === "string") {
            messages.set(item.id, item.text);
            options.progress.summary(
              item.text,
              event.method === "item/completed",
            );
            if (event.method === "item/completed") finalMessage = item.text;
          }
          if (event.method === "item/completed")
            options.progress.activity("response", "completed");
        }
      } else if (event.method === "turn/completed") {
        const turn = params.turn;
        if (!turn || (turnId && turn.id !== turnId)) {
          invalid();
          return;
        }
        if (turn.status !== "completed") {
          finish(
            options.errorFor(
              String(turn.error?.message || "native turn failed"),
            ),
          );
          return;
        }
        if (!finalMessage.trim()) {
          invalid();
          return;
        }
        options.progress.activity("model", "completed");
        finish();
      } else if (event.method === "error") {
        finish(
          options.errorFor(
            String(params.error?.message || "native turn failed"),
          ),
        );
      }
    };
    child.stdout.on("data", (data: Buffer) => {
      total += data.length;
      if (total > MAX_OUTPUT) {
        finish(
          new Error(
            "Codex output exceeded the size limit. / Codex 输出超出大小限制。",
          ),
        );
        return;
      }
      buffer += decoder.write(data);
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consume(line);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-16000);
    });
    child.stdin.on("error", () =>
      finish(
        new Error("Codex native connection closed. / Codex 原生连接已关闭。"),
      ),
    );
    child.once("error", (error) => finish(options.errorFor(error.message)));
    child.once("close", () => {
      if (settled) return;
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      if (!settled)
        finish(
          options.errorFor(
            stderr || "native connection closed before turn completed",
          ),
        );
    });
    options.progress.activity("connection", "running", "启动本机 Codex 原生流");
    request(1, "initialize", {
      clientInfo: { name: "telldo", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
  });
}
