import { describe, it, expect } from "vitest";
import { SshProgressDecoder } from "../src/main/ssh-response-stream";
describe("SSH answer deltas", () => {
  it("forwards each word before the final frame and remains compatible with older helpers", () => {
    const decoder = new SshProgressDecoder();
    expect(decoder.decode({ type: "response", delta: "你好" })).toEqual({
      type: "response",
      text: "你好",
    });
    expect(decoder.decode({ type: "response", delta: "，世界" })).toEqual({
      type: "response",
      text: "你好，世界",
    });
    expect(decoder.decode({ type: "response", text: "校验后的全文" })).toEqual({
      type: "response",
      text: "校验后的全文",
    });
  });
  it("bounds accumulated content and rejects mixed/invalid delta envelopes", () => {
    const decoder = new SshProgressDecoder();
    expect(decoder.decode({ type: "response", delta: 7 })).toBeNull();
    expect(
      decoder.decode({ type: "response", delta: "x", text: "y" }),
    ).toBeNull();
    expect(
      decoder.decode({ type: "response", delta: "x".repeat(2000) }),
    ).not.toBeNull();
    expect(decoder.decode({ type: "response", delta: "overflow" })).toBeNull();
  });
});
