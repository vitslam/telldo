import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseAIResponse, parseProposal } from "../src/shared/proposal";

const list = (temp_id = "new-list") => ({
  type: "create_list",
  temp_id,
  patch: { name: "Lazyfish·Codex-WebUI" },
});
const task = (list_id = "new-list", temp_id = "new-task") => ({
  type: "create",
  temp_id,
  patch: { title: "跨会话记忆", list_id },
});
const proposal = (actions: unknown[]) => ({
  version: 1,
  summary: "创建清单",
  idempotency_key: "list-proposal",
  risk: "low",
  actions,
});

describe("list proposal protocol", () => {
  it("accepts a new list as its own high-risk proposal", () => {
    const result = parseProposal(proposal([list()]));
    expect(result.risk).toBe("high");
    expect(result.actions).toEqual([list()]);
  });
  it("decodes wire patch entries and trims the list name", () => {
    const result = parseProposal(
      proposal([
        {
          type: "create_list",
          target_id: null,
          expected_version: null,
          temp_id: "new-list",
          patch: [
            { key: "name", value: "  Reading  " },
            { key: "color", value: "#AABBCC" },
          ],
        },
      ]),
    );
    expect(result.actions[0].patch).toEqual({
      name: "Reading",
      color: "#AABBCC",
    });
  });
  it.each([
    { type: "create_list", patch: { name: "Reading" } },
    { ...list(), temp_id: null },
    { ...list(), temp_id: "" },
    { ...list(), target_id: "existing-list" },
    { ...list(), expected_version: 1 },
    { ...list(), patch: { name: "   " } },
    { ...list(), patch: { name: "x".repeat(201) } },
    { ...list(), patch: { name: "Reading", color: "red" } },
    { ...list(), patch: { name: "Reading", title: "Wrong entity" } },
    { ...list(), patch: { name: "Reading", list_id: "existing" } },
  ])("rejects malformed list actions %#", (action) => {
    expect(() => parseProposal(proposal([action]))).toThrow();
  });
  it("rejects list fields in a task action and duplicate wire fields", () => {
    expect(() =>
      parseProposal(
        proposal([
          {
            ...task("existing"),
            patch: { ...task("existing").patch, name: "List-only field" },
          },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseProposal(
        proposal([
          {
            ...list(),
            patch: [
              { key: "name", value: "A" },
              { key: "name", value: "B" },
            ],
          },
        ]),
      ),
    ).toThrow(/duplicate/i);
  });
  it("keeps generic earlier list and task reference support", () => {
    const result = parseProposal(
      proposal([
        list(),
        task(),
        {
          ...task("new-list", "child"),
          patch: { ...task().patch, parent_id: "new-task" },
        },
      ]),
    );
    expect(result.actions).toHaveLength(3);
  });
  it("rejects collisions across temporary list and task IDs", () => {
    expect(() =>
      parseProposal(proposal([list(), task("new-list", "new-list")])),
    ).toThrow(/Duplicate temporary/);
    expect(() => parseProposal(proposal([list(), list()]))).toThrow(
      /Duplicate temporary/,
    );
  });
  it.each([
    [task(), list()],
    [
      list(),
      { ...task(), patch: { ...task().patch, parent_id: "later-task" } },
      task("new-list", "later-task"),
    ],
    [list(), { ...task(), patch: { ...task().patch, parent_id: "new-task" } }],
  ])("rejects forward and self references %#", (...actions) => {
    expect(() => parseProposal(proposal(actions))).toThrow(/must follow/);
  });
  it("rejects task IDs used as lists and list IDs used as parents or targets", () => {
    expect(() =>
      parseProposal(proposal([task("existing"), task("new-task", "second")])),
    ).toThrow(/requires a list/);
    expect(() =>
      parseProposal(
        proposal([
          list(),
          { ...task(), patch: { ...task().patch, parent_id: "new-list" } },
        ]),
      ),
    ).toThrow(/requires a task/);
    expect(() =>
      parseProposal(
        proposal([
          list(),
          {
            type: "complete",
            target_id: "new-list",
            expected_version: 1,
            patch: {},
          },
        ]),
      ),
    ).toThrow(/existing task/);
  });
  it("does not treat an update's optional temp_id as a creation definition", () => {
    expect(() =>
      parseProposal(
        proposal([
          {
            type: "update",
            target_id: "existing-task",
            expected_version: 1,
            temp_id: "not-created",
            patch: { title: "Updated" },
          },
          task("not-created"),
        ]),
      ),
    ).toThrow(/requires a list/);
  });
  it("preserves existing task proposals and successful read-only answers", () => {
    const old = parseProposal(
      proposal([
        {
          type: "create",
          patch: { title: "Old task", list_id: "existing-list" },
        },
      ]),
    );
    expect(old.risk).toBe("low");
    expect(
      parseProposal(
        proposal([
          {
            type: "update",
            target_id: "existing-task",
            expected_version: 2,
            patch: { notes: "Updated" },
          },
        ]),
      ).actions,
    ).toHaveLength(1);
    expect(parseAIResponse(proposal([])).actions).toEqual([]);
    expect(() => parseProposal(proposal([]))).toThrow();
  });
  it("counts list actions toward the existing action limit", () => {
    const fifty = [
      list(),
      ...Array.from({ length: 49 }, (_, index) =>
        task("new-list", `task-${index}`),
      ),
    ];
    expect(parseProposal(proposal(fifty)).actions).toHaveLength(50);
    expect(() =>
      parseProposal(proposal([...fifty, task("new-list", "task-50")])),
    ).toThrow();
  });
  it("advertises the new action and patch fields to both transports", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../resources/proposal.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const properties = schema.properties.actions.items.properties;
    expect(properties.type.enum).toContain("create_list");
    expect(properties.patch.items.properties.key.enum).toEqual(
      expect.arrayContaining(["name", "color", "list_id"]),
    );
  });
});
