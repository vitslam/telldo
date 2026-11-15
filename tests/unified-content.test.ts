import { expect, it } from "vitest";
import { parseAIResponse, parseProposal } from "../src/shared/proposal";
const base = {
  version: 1,
  summary: "Proposed",
  idempotency_key: "unified-1",
  risk: "high",
};
it("keeps AI-selected attachments outside task columns and task mutation validation", () => {
  const result = parseAIResponse({
    ...base,
    actions: [
      {
        type: "create",
        temp_id: "todo",
        target_id: null,
        expected_version: null,
        patch: [
          { key: "title", value: "Read this" },
          { key: "list_id", value: "life" },
          { key: "attachment_ids", value: ["image-1", "image-1"] },
        ],
      },
    ],
  });
  expect(result.assetAssignments).toEqual([
    { actionIndex: 0, attachmentIds: ["image-1"] },
  ]);
  expect(result.actions[0].patch).toEqual({
    title: "Read this",
    list_id: "life",
  });
  expect(
    parseProposal({ ...base, actions: result.actions }).actions,
  ).toHaveLength(1);
});
it("supports retaining reference content together with a separately approved todo", () => {
  const result = parseAIResponse({
    ...base,
    actions: [
      {
        type: "save_memo",
        temp_id: "note",
        patch: { text: "Original reference", attachment_ids: ["image-1"] },
      },
      {
        type: "create",
        temp_id: "todo",
        patch: {
          title: "Review",
          list_id: "work",
          attachment_ids: ["image-1"],
        },
      },
    ],
  });
  expect(result.memo?.text).toBe("Original reference");
  expect(result.actions).toHaveLength(1);
  expect(result.assetAssignments?.[0].actionIndex).toBe(0);
});
it("rejects attachment metadata on list creation/deletion and invalid IDs", () => {
  for (const action of [
    {
      type: "create_list",
      temp_id: "list",
      patch: { name: "Notes", attachment_ids: ["a"] },
    },
    {
      type: "delete",
      target_id: "todo",
      expected_version: 1,
      patch: { attachment_ids: ["a"] },
    },
    {
      type: "create",
      temp_id: "todo",
      patch: { title: "x", list_id: "work", attachment_ids: [123] },
    },
  ])
    expect(() => parseAIResponse({ ...base, actions: [action] })).toThrow();
});
