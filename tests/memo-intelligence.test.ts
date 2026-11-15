import { describe, expect, it } from "vitest";
import { parseAIResponse, parseProposal } from "../src/shared/proposal";
import { conversationContext } from "../src/shared/conversation";
const base = {
  version: 1,
  summary: "已收进备忘录。",
  idempotency_key: "memo-1",
  risk: "low",
};
const capture = {
  type: "save_memo",
  temp_id: "memo-local-1",
  patch: {
    title: "周末的想法",
    text: "第一行\n第二行",
    summary: "关于周末的两行想法。",
  },
};
describe("memo response boundaries", () => {
  it("normalizes capture separately from task proposals and preserves original lines", () => {
    const result = parseAIResponse({ ...base, actions: [capture] });
    expect(result.actions).toEqual([]);
    expect(result.memo).toEqual({
      tempId: "memo-local-1",
      title: "周末的想法",
      text: "第一行\n第二行",
      summary: "关于周末的两行想法。",
    });
    expect(() => parseProposal({ ...base, actions: [capture] })).toThrow();
  });
  it("accepts wire-format capture without introducing nullable task targets", () => {
    expect(
      parseAIResponse({
        ...base,
        actions: [
          {
            ...capture,
            target_id: null,
            expected_version: null,
            patch: [{ key: "text", value: "留下一段话。" }],
          },
        ],
      }).memo,
    ).toEqual({ tempId: "memo-local-1", text: "留下一段话。" });
  });
  it("rejects multiple captures, empty text and unknown fields", () => {
    for (const actions of [
      [capture, { ...capture, temp_id: "memo-2" }],
      [{ ...capture, patch: { text: "   " } }],
      [{ ...capture, patch: { text: "hello", list_id: "work" } }],
      [{ ...capture, target_id: "existing-memo" }],
      [{ ...capture, expected_version: 1 }],
    ])
      expect(() => parseAIResponse({ ...base, actions })).toThrow();
  });
  it("rejects duplicate patch fields and oversized payloads", () => {
    expect(() =>
      parseAIResponse({
        ...base,
        actions: [
          {
            ...capture,
            patch: [
              { key: "text", value: "one" },
              { key: "text", value: "two" },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAIResponse({
        ...base,
        actions: [{ ...capture, patch: { text: "x".repeat(20001) } }],
      }),
    ).toThrow();
  });
  it("keeps ordinary answers and todo creation on their existing paths", () => {
    expect(parseAIResponse({ ...base, actions: [] }).memo).toBeUndefined();
    const result = parseAIResponse({
      ...base,
      actions: [
        {
          type: "create",
          temp_id: "task",
          patch: { title: "Buy coffee", list_id: "life" },
        },
      ],
    });
    expect(result.memo).toBeUndefined();
    expect(result.actions[0].type).toBe("create");
  });
  it("whitelists bounded memo excerpts and attachment metadata without paths or binary data", () => {
    const result = conversationContext({
      memoInventory: { total: 50, included: 30, secret: "no" },
      memoSearchResults: Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        title: "t".repeat(300),
        body: "b".repeat(5000),
        summary: "s".repeat(800),
        created_at: "2026-11-15",
        path: "/private/source",
        attachments: [
          {
            name: "a.png",
            kind: "image",
            bytes: 42,
            path: "/private/a",
            base64: "secret",
          },
        ],
      })),
      capture: {
        memoId: "m1",
        text: "x".repeat(15000),
        title: "a",
        instructions: "no",
        attachments: [{ name: "b.pdf", kind: "file", path: "/private/b" }],
      },
    });
    expect(result.memoInventory).toEqual({ total: 50, included: 12 });
    expect(result.memoSearchResults).toHaveLength(12);
    expect(result.memoSearchResults![0].body).toHaveLength(4000);
    expect(result.memoSearchResults![0].title).toHaveLength(200);
    expect(result.memoSearchResults![0].summary).toHaveLength(500);
    expect(result.capture!.text).toHaveLength(12000);
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.memoSearchResults![0].attachments).toEqual([
      { name: "a.png", kind: "image", bytes: 42 },
    ]);
  });
  it("omits malformed capture and memo inventory metadata", () => {
    const result = conversationContext({
      memoInventory: { total: -1 },
      capture: { memoId: "x".repeat(201), text: "hello" },
      memoSearchResults: [{ id: "", body: "hello" }],
    });
    expect(result.memoInventory).toBeUndefined();
    expect(result.capture).toBeUndefined();
    expect(result.memoSearchResults).toEqual([]);
  });
});
