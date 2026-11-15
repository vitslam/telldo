import { describe, it, expect } from "vitest";
import { ModelRoundProgress } from "../src/main/model-round-progress";
import type { AIProgress } from "../src/shared/ai-progress";
describe("public replies across model rounds", () => {
  it("keeps intermediate replies and suppresses repeated connection plumbing", () => {
    const events: AIProgress[] = [];
    for (const round of [1, 2]) {
      const progress = new ModelRoundProgress(round, true, (event) =>
        events.push(event),
      );
      progress.forward({
        type: "activity",
        id: "connection",
        phase: "connection",
        status: "completed",
        label: "连接 Codex",
      });
      progress.forward({ type: "response", text: `第${round}轮公开回复` });
      progress.forward({
        type: "activity",
        id: "response",
        phase: "response",
        status: "completed",
        label: "生成回复",
      });
      progress.complete(`第${round}轮完整公开回复`);
    }
    expect(JSON.stringify(events)).not.toContain("connection");
    for (const round of [1, 2])
      expect(events).toContainEqual(
        expect.objectContaining({
          id: `model-${round}-response`,
          status: "completed",
          text: `第${round}轮完整公开回复`,
        }),
      );
  });
  it("never turns arbitrary raw output into public commentary", () => {
    const events: AIProgress[] = [];
    const progress = new ModelRoundProgress(1, false, (e) => events.push(e));
    progress.forward("PRIVATE RAW OUTPUT");
    progress.forward({
      type: "activity",
      id: "model",
      phase: "model",
      status: "running",
      label: "Processing",
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|text/);
  });
});
