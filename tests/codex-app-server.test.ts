import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runAppServer, APP_SERVER_ARGS } from "../src/main/codex-app-server";
import type { CodexProgressTracker } from "../src/shared/ai-progress";

function fixture(
  onTurn?: (
    emit: (method: string, params: unknown) => void,
    raw: (value: string | Buffer) => void,
  ) => void,
  timeoutMs = 200,
) {
  const requests: any[] = [];
  const summaries: string[] = [];
  let abort: (error: Error) => void = () => {};
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit("close", null);
    return true;
  });
  const emit = (method: string, params: unknown) =>
    child.stdout.write(JSON.stringify({ method, params }) + "\n");
  const raw = (value: string | Buffer) => child.stdout.write(value);
  const response = (id: number, result: unknown) =>
    child.stdout.write(JSON.stringify({ id, result }) + "\n");
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    let index: number;
    while ((index = input.indexOf("\n")) !== -1) {
      const request = JSON.parse(input.slice(0, index));
      input = input.slice(index + 1);
      requests.push(request);
      queueMicrotask(() => {
        if (request.method === "initialize") response(request.id, {});
        if (request.method === "thread/start")
          response(request.id, { thread: { id: "thread-1" } });
        if (request.method === "turn/start") {
          response(request.id, { turn: { id: "turn-1" } });
          if (onTurn) onTurn(emit, raw);
        }
      });
    }
  });
  const spawn = vi.fn(
    (_file: string, _args: string[], _options: Record<string, unknown>) =>
      child as ChildProcessWithoutNullStreams,
  );
  const promise = runAppServer({
    spawn,
    executable: "/Codex Path/codex",
    cwd: "/private/owned/work",
    env: { PATH: "/bin" },
    prompt: "Request",
    schema: { type: "object" },
    imagePaths: ["/private/owned/image.png"],
    timeoutMs,
    progress: {
      activity: vi.fn(),
      summary: (value: string) => summaries.push(value),
    } as unknown as CodexProgressTracker,
    registerAbort: (value) => {
      abort = value;
    },
    errorFor: (text) => new Error(text),
  });
  return {
    promise,
    spawn,
    child,
    requests,
    summaries,
    abort: (error: Error) => abort(error),
  };
}
const scope = { threadId: "thread-1", turnId: "turn-1" };
const final = '{"summary":"你好，逐字回复。","actions":[]}';
describe("owned native Codex app-server", () => {
  it("delivers raw incremental agent text before turn completion, across UTF-8 chunks", async () => {
    const h = fixture((emit, raw) => {
      emit("item/started", {
        ...scope,
        item: { id: "reply-1", type: "agentMessage", text: "" },
      });
      let cumulative = "";
      for (const delta of [
        '{"summary":"',
        "你",
        "好，",
        "逐字",
        "回复。",
        '","actions":[]}',
      ]) {
        cumulative += delta;
        const bytes = Buffer.from(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { ...scope, itemId: "reply-1", delta },
          }) + "\n",
        );
        for (const byte of bytes) raw(Buffer.from([byte]));
      }
      emit("item/completed", {
        ...scope,
        item: { id: "reply-1", type: "agentMessage", text: final },
      });
      emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
    });
    await expect(h.promise).resolves.toBe(final);
    expect(
      h.summaries.some(
        (value) => value.length < final.length && value.includes("summary"),
      ),
    ).toBe(true);
    expect(
      h.requests.find((r) => r.method === "thread/start").params,
    ).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      dynamicTools: [],
    });
    expect(
      h.requests.find((r) => r.method === "turn/start").params,
    ).toMatchObject({
      outputSchema: { type: "object" },
      input: [
        { type: "text", text: "Request", text_elements: [] },
        { type: "localImage", path: "/private/owned/image.png" },
      ],
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][1]).toEqual(APP_SERVER_ARGS);
    expect(h.child.kill).toHaveBeenCalled();
  });
  it("rejects native tool items including camelCase names", async () => {
    const h = fixture((emit) =>
      emit("item/started", {
        ...scope,
        item: { id: "tool", type: "commandExecution", command: "private" },
      }),
    );
    await expect(h.promise).rejects.toThrow(/tool call/i);
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.summaries).toEqual([]);
  });
  it("denies server-side permission/tool requests instead of granting approval", async () => {
    const h = fixture((_emit, raw) =>
      raw(
        JSON.stringify({
          id: 90,
          method: "item/tool/call",
          params: { secret: "private" },
        }) + "\n",
      ),
    );
    await expect(h.promise).rejects.toThrow(/tool call/i);
    expect(h.requests).toContainEqual(
      expect.objectContaining({
        id: 90,
        error: expect.objectContaining({ code: -32601 }),
      }),
    );
  });
  it("ignores unrelated threads and never exposes reasoning events", async () => {
    const h = fixture((emit) => {
      emit("item/agentMessage/delta", {
        threadId: "unrelated",
        turnId: "other",
        itemId: "bad",
        delta: "PRIVATE",
      });
      emit("item/completed", {
        ...scope,
        item: { id: "reasoning", type: "reasoning", text: "PRIVATE" },
      });
      emit("item/completed", {
        ...scope,
        item: { id: "reply", type: "agentMessage", text: final },
      });
      emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
    });
    await h.promise;
    expect(h.summaries.join("")).not.toContain("PRIVATE");
  });
  it("kills only the owned process on cancellation", async () => {
    const h = fixture();
    h.abort(new Error("Cancelled"));
    await expect(h.promise).rejects.toThrow("Cancelled");
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
  it("does not return a partial message from a failed turn or retry inference", async () => {
    const h = fixture((emit) => {
      emit("item/agentMessage/delta", {
        ...scope,
        itemId: "reply",
        delta: '{"summary":"Partial',
      });
      emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "quota" } },
      });
    });
    await expect(h.promise).rejects.toThrow("quota");
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
  it("enforces timeout and rejects invalid JSON events", async () => {
    const timeout = fixture(undefined, 10);
    await expect(timeout.promise).rejects.toThrow(/timed out/);
    const invalid = fixture((_emit, raw) => raw("NOT JSON\n"));
    await expect(invalid.promise).rejects.toThrow(/invalid native/);
  });
});
