import { describe, it, expect } from "vitest";
import { parseAIResponse, parseProposal } from "../src/shared/proposal";
import { conversationContext } from "../src/shared/conversation";
const base = {
  version: 1,
  summary: "Find matching records",
  idempotency_key: "query-1",
  risk: "high",
};
const request = (patch: Record<string, unknown>) => ({
  ...base,
  actions: [
    {
      type: "request_context",
      target_id: null,
      temp_id: null,
      expected_version: null,
      patch: Object.entries(patch).map(([key, value]) => ({ key, value })),
    },
  ],
});
describe("bounded read protocol", () => {
  it("normalizes a read without creating an applicable mutation proposal", () => {
    const raw = request({
      entity: "tasks",
      status: "todo",
      limit: 15,
      offset: 0,
    });
    expect(parseAIResponse(raw)).toMatchObject({
      actions: [],
      risk: "low",
      query: { entity: "tasks", status: "todo", limit: 15, offset: 0 },
    });
    expect(() => parseProposal(raw)).toThrow();
  });
  it("allows stable record IDs without accepting filenames as source content", () => {
    expect(
      parseAIResponse(
        request({ entity: "record", kind: "memo", id: "record-id" }),
      ).query,
    ).toEqual({ entity: "record", kind: "memo", id: "record-id" });
    expect(() =>
      parseAIResponse(request({ entity: "record", id: "missing-kind" })),
    ).toThrow();
    expect(() =>
      parseAIResponse(
        request({
          entity: "record",
          kind: "memo",
          id: "r",
          path: "/private/source",
        }),
      ),
    ).toThrow();
  });
  it("rejects unbounded or invalid filters, arbitrary SQL and oversized search", () => {
    for (const patch of [
      { entity: "tasks", limit: 31 },
      { entity: "tasks", offset: 10001 },
      { entity: "tasks", keywords: "x".repeat(201) },
      { entity: "tasks", sql: "select *" },
      { entity: "tasks", status: "pending" },
      { entity: "schedule", from: "2026-11-01", to: "2026-12-02" },
      { entity: "schedule", from: "2026-02-30", to: "2026-03-01" },
      { entity: "schedule", from: "2026-11-15" },
    ])
      expect(() => parseAIResponse(request(patch))).toThrow();
  });
  it("never mixes a read with mutation/capture actions and rejects forged read targets", () => {
    const raw = request({ entity: "memos", keywords: "image.png", limit: 3 });
    expect(() =>
      parseAIResponse({
        ...raw,
        actions: [
          ...raw.actions,
          { type: "delete", target_id: "task", expected_version: 1, patch: [] },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAIResponse({
        ...raw,
        actions: [{ ...raw.actions[0], target_id: "task" }],
      }),
    ).toThrow();
    expect(() =>
      parseAIResponse({ ...raw, actions: [...raw.actions, ...raw.actions] }),
    ).toThrow();
  });
  it("keeps history to a total budget and preserves only bounded exact source references", () => {
    const context = conversationContext({
      contextPhase: "referenced",
      conversation: Array.from({ length: 12 }, (_, i) => ({
        role: "user",
        content: `${i}`.repeat(3000),
      })),
      referencedRecords: Array.from({ length: 8 }, (_, i) => ({
        kind: "memo",
        id: `m${i}`,
        title: "T".repeat(500),
        text: "Z".repeat(20000),
        path: "/private/source",
        instructions: "ignored",
        attachments: [
          {
            id: "image-id",
            name: "photo.png",
            kind: "image",
            path: "/private/photo",
            base64: "must-not-send",
          },
        ],
      })),
    });
    expect(
      context.conversation.reduce((sum, m) => sum + m.content.length, 0),
    ).toBeLessThanOrEqual(6000);
    expect(context.referencedRecords).toHaveLength(4);
    expect(
      context.referencedRecords!.reduce((sum, r) => sum + r.text.length, 0),
    ).toBeLessThanOrEqual(24000);
    expect(context.referencedRecords![0]).toMatchObject({
      kind: "memo",
      id: "m0",
      truncated: true,
      attachments: [{ id: "image-id", name: "photo.png", kind: "image" }],
    });
    expect(JSON.stringify(context)).not.toContain("/private");
    expect(JSON.stringify(context)).not.toContain("must-not-send");
  });
  it("keeps query metadata bounded and does not pass arbitrary fields", () => {
    const context = conversationContext({
      contextPhase: "result",
      contextReadBudget: { remaining: 0, used: 2, max: 100 },
      queryResult: {
        entity: "memos",
        filters: { keywords: "reference", sql: "no" },
        total: 2000,
        returned: 6,
        limit: 6,
        offset: 0,
        nextOffset: 6,
        hasMore: true,
        truncated: true,
        coverage: "excerpt",
        private: "no",
      },
    });
    expect(context.contextReadBudget).toEqual({
      remaining: 0,
      used: 2,
      max: 2,
    });
    expect(context.queryResult).toMatchObject({
      entity: "memos",
      total: 2000,
      returned: 6,
      hasMore: true,
      nextOffset: 6,
    });
    expect(JSON.stringify(context)).not.toContain("sql");
    expect(JSON.stringify(context)).not.toContain("private");
  });
  it("does not leak domain content into planning context", () => {
    const context = conversationContext({
      contextPhase: "plan",
      memoInventory: { total: 1, included: 1 },
      memoSearchResults: [{ id: "r", body: "private body" }],
      referencedRecords: [{ kind: "memo", id: "r", text: "private ref" }],
      inventory: { ordinaryTotal: 200 },
      readOnlySchedule: { instances: [{ title: "private event" }] },
      readOnlyRecurrences: { series: [{ title: "private repeat" }] },
      recentReferences: [
        {
          kind: "memo",
          id: "known-id",
          title: "known title",
          text: "private content",
        },
      ],
    });
    expect(context.recentReferences).toEqual([
      { kind: "memo", id: "known-id", title: "known title" },
    ]);
    expect(JSON.stringify(context)).not.toContain("private");
    expect(context.memoSearchResults).toBeUndefined();
    expect(context.referencedRecords).toBeUndefined();
    expect(context.inventory).toBeUndefined();
  });
});
