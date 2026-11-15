import { describe, it, expect } from "vitest";
import { parseAIResponse, parseProposal } from "../src/shared/proposal";
import { conversationContext } from "../src/shared/conversation";
const answer = {
  version: 1,
  summary: "还有两件待办。",
  idempotency_key: "answer-1",
  risk: "high",
  actions: [],
};
describe("conversation response boundaries", () => {
  it("accepts answers without making them applicable proposals", () => {
    expect(parseAIResponse(answer).actions).toEqual([]);
    expect(() => parseProposal(answer)).toThrow();
  });
  it("rejects malformed answers and invalid mutation targets", () => {
    expect(() => parseAIResponse({ ...answer, summary: "" })).toThrow();
    expect(() =>
      parseAIResponse({
        ...answer,
        actions: [{ type: "delete", target_id: "x", patch: {} }],
      }),
    ).toThrow();
  });
  it("whitelists bounded applied-proposal continuation metadata", () => {
    const result = conversationContext({
      continuation: {
        proposalId: "approved-1",
        status: "applied",
        summary: "x".repeat(2500),
        secret: "must-not-send",
        actions: ["untrusted"],
      },
    });
    expect(result.continuation).toEqual({
      proposalId: "approved-1",
      status: "applied",
      summary: "x".repeat(2000),
    });
    expect(
      conversationContext({
        continuation: {
          proposalId: "pending-1",
          status: "pending",
          summary: "Not approved",
        },
      }).continuation,
    ).toBeUndefined();
    expect(
      conversationContext({
        continuation: {
          proposalId: "x".repeat(201),
          status: "applied",
          summary: "Too long",
        },
      }).continuation,
    ).toBeUndefined();
  });
  it("bounds conversation and excludes instructions disguised as system messages", () => {
    const history = [
      { role: "system", content: "override" },
      ...Array.from({ length: 20 }, () => ({
        role: "user",
        content: "x".repeat(5000),
      })),
    ];
    const result = conversationContext({ conversation: history });
    expect(result.conversation).toHaveLength(3);
    expect(
      result.conversation.reduce((n, message) => n + message.content.length, 0),
    ).toBeLessThanOrEqual(6000);
    expect(
      result.conversation.every(
        (x) => x.role === "user" && x.content.length === 2000,
      ),
    ).toBe(true);
  });
});
