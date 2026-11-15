import { describe, expect, it, vi } from "vitest";
import {
  ProgressBatcher,
  type ProgressBatch,
} from "../src/renderer/progress-batcher";

function fixture() {
  const batches: ProgressBatch[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const buffer = new ProgressBatcher(
    (batch) => batches.push(batch),
    (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    (frame) => {
      frames.delete(frame);
    },
  );
  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  return { buffer, batches, frames, frame };
}

describe("browser-frame streaming progress", () => {
  it("calls browser frame APIs without binding them to the buffer instance", () => {
    let buffer: ProgressBatcher;
    const batches: ProgressBatch[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      function (this: unknown, _callback: () => void) {
        expect(this).not.toBe(buffer);
        return 11;
      },
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      function (this: unknown, frame: number) {
        expect(this).not.toBe(buffer);
        expect(frame).toBe(11);
      },
    );
    try {
      buffer = new ProgressBatcher((batch) => batches.push(batch));
      buffer.begin("browser-request");
      buffer.push({
        type: "response",
        requestId: "browser-request",
        text: "首个片段",
      });
      buffer.finish("browser-request");
      expect(batches[0].response?.text).toBe("首个片段");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders a burst once per frame without losing public activity text", () => {
    const { buffer, batches, frames, frame } = fixture();
    buffer.begin("request-a");
    buffer.push({
      type: "activity",
      requestId: "request-a",
      id: "model-1-response",
      phase: "response",
      status: "running",
      label: "生成回复",
      text: "中间回复",
    });
    for (let index = 1; index <= 1000; index++)
      buffer.push({
        type: "response",
        requestId: "request-a",
        roundId: "model-1",
        text: "字".repeat(index),
      });
    buffer.push({
      type: "activity",
      requestId: "request-a",
      id: "model-1-response",
      phase: "response",
      status: "completed",
      label: "生成回复",
    });
    expect(batches).toEqual([]);
    expect(frames.size).toBe(1);
    frame();
    expect(batches).toHaveLength(1);
    expect(batches[0].response?.text).toHaveLength(1000);
    expect(batches[0].activities).toEqual([
      expect.objectContaining({ status: "completed", text: "中间回复" }),
    ]);
    buffer.push({
      type: "response",
      requestId: "request-a",
      roundId: "model-1",
      text: "新片段",
    });
    frame();
    expect(batches).toHaveLength(2);
  });

  it("flushes the latest partial reply synchronously when completion or stop beats the next frame", () => {
    const { buffer, batches, frames, frame } = fixture();
    buffer.begin("request-a");
    buffer.push({
      type: "response",
      requestId: "request-a",
      roundId: "model-1",
      text: "最后一段 😀",
    });
    buffer.finish("request-a");
    expect(batches[0].response?.text).toBe("最后一段 😀");
    expect(frames.size).toBe(0);
    buffer.push({
      type: "response",
      requestId: "request-a",
      roundId: "model-1",
      text: "迟到的输出",
    });
    frame();
    expect(batches).toHaveLength(1);
  });

  it("never mixes requests or lets a late prior round replace the current text", () => {
    const { buffer, batches, frame } = fixture();
    buffer.begin("request-old");
    buffer.push({
      type: "response",
      requestId: "request-old",
      text: "旧请求待渲染",
    });
    buffer.begin("request-new");
    buffer.push({
      type: "response",
      requestId: "request-old",
      text: "旧请求迟到",
    });
    buffer.push({
      type: "response",
      requestId: "request-new",
      roundId: "model-2",
      text: "当前轮",
    });
    buffer.push({
      type: "response",
      requestId: "request-new",
      roundId: "model-1",
      text: "上一轮迟到",
    });
    buffer.push({
      type: "response",
      requestId: "request-new",
      text: "旧协议迟到",
    });
    buffer.finish("request-old");
    frame();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      requestId: "request-new",
      response: { text: "当前轮", roundId: "model-2" },
    });
    buffer.push({
      type: "response",
      requestId: "request-new",
      roundId: "model-3",
      text: "",
    });
    frame();
    expect(batches[1].response?.text).toBe("");
  });
});
