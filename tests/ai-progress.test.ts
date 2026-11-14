import { describe, expect, it } from "vitest";
import {
  CodexProgressTracker,
  parseAIProgress,
  responseSummary,
  type AIProgress,
} from "../src/shared/ai-progress";

describe("public Codex progress", () => {
  it("extracts only the top-level summary, including a partial escaped string", () => {
    expect(
      responseSummary(
        '{"actions":[{"summary":"hidden"}],"summary":"你好\\n世界',
      ),
    ).toBe("你好\n世界");
    expect(
      responseSummary('{"summary":"hello\\u4e16\\u754c\\uD83D\\uDE00'),
    ).toBe("hello世界😀");
    expect(responseSummary('{"summary":"hello\\uD83D')).toBe("hello");
    expect(responseSummary('{"summary":"hello\\u4e')).toBe("hello");
    expect(responseSummary('{"actions":[{"summary":"hidden"}]}')).toBe("");
    expect(responseSummary("private reasoning or raw text")).toBe("");
  });

  it("streams actual summary snapshots without exposing reasoning or schema fields", () => {
    const events: AIProgress[] = [];
    const progress = new CodexProgressTracker((event) => events.push(event));
    progress.consume({ type: "turn.started" });
    progress.consume({
      type: "item.completed",
      item: { type: "reasoning", text: "PRIVATE REASONING" },
    });
    progress.consume({
      type: "item.updated",
      item: {
        type: "agent_message",
        text: '{"summary":"This is a sufficiently long partial answer',
      },
    });
    progress.consume({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: '{"summary":"This is a sufficiently long partial answer, finished.","actions":[]}',
      },
    });
    progress.consume({ type: "turn.completed" });
    expect(
      events.filter(
        (event) => typeof event !== "string" && event.type === "response",
      ),
    ).toEqual([
      { type: "response", text: "This is a sufficiently long partial answer" },
      {
        type: "response",
        text: "This is a sufficiently long partial answer, finished.",
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|actions|agent_message/);
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "model", status: "completed" }),
    );
  });

  it("accepts only bounded known helper progress and regenerates public labels", () => {
    expect(
      parseAIProgress({
        type: "activity",
        id: "reasoning",
        phase: "reasoning",
        status: "running",
      }),
    ).toBeNull();
    expect(
      parseAIProgress({
        type: "activity",
        id: "model",
        phase: "model",
        status: "running",
        label: "UNTRUSTED",
        detail: "a".repeat(300),
      }),
    ).toEqual({
      type: "activity",
      id: "model",
      phase: "model",
      status: "running",
      label: "处理请求",
      detail: "a".repeat(240),
    });
    expect(
      parseAIProgress({ type: "response", text: "x".repeat(2100) }),
    ).toEqual({ type: "response", text: "x".repeat(2000) });
  });
});
