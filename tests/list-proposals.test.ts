import { afterEach, describe, expect, it } from "vitest";
import { TaskService } from "../src/main/task-service";
import type { ProposalAction } from "../src/shared/types";

const services: TaskService[] = [];
const service = () => {
  const instance = new TaskService(":memory:");
  services.push(instance);
  return instance;
};
const proposal = (actions: ProposalAction[], key = "list-plan") => ({
  version: 1 as const,
  summary: "Create a project list",
  idempotency_key: key,
  risk: "low" as const,
  actions,
});
const listAction = (
  name = "Lazyfish·Codex-WebUI",
  temp_id = "new-list",
): ProposalAction => ({
  type: "create_list",
  temp_id,
  patch: { name, color: "#85639d" },
});
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

describe("AI list proposals", () => {
  it("keeps independent list and task proposals read-only until confirmed and undoes them in reverse order", () => {
    const s = service();
    const baseline = s.listLists();
    const listProposal = s.saveProposal(
      proposal([listAction()]),
      "新建清单",
      "",
      [],
    );
    expect(listProposal.risk).toBe("high");
    expect(s.listLists()).toEqual(baseline);
    expect(() => s.applyProposal(listProposal.id)).toThrow(/confirmation/);
    expect(s.listLists()).toEqual(baseline);
    s.applyProposal(listProposal.id, true);
    s.applyProposal(listProposal.id, true);
    const list = s.listLists().find((l) => l.name === "Lazyfish·Codex-WebUI")!;
    expect(list.color).toBe("#85639d");
    expect(s.listLists()).toHaveLength(baseline.length + 1);
    const tasks = s.saveProposal(
      proposal(
        [
          {
            type: "create",
            patch: { list_id: list.id, title: "跨会话记忆。" },
          },
          {
            type: "create",
            patch: { list_id: list.id, title: "支持引用对话记录中的段落。" },
          },
        ],
        "tasks-plan",
      ),
      "新增待办",
      "",
      [],
    );
    expect(s.listTasks()).toHaveLength(0);
    s.applyProposal(tasks.id, true);
    expect(() => s.undoProposal(listProposal.id)).toThrow(/new tasks/);
    expect(s.listTasks().map((t) => t.title)).toEqual([
      "跨会话记忆。",
      "支持引用对话记录中的段落。",
    ]);
    s.undoProposal(tasks.id);
    s.undoProposal(listProposal.id);
    expect(s.listTasks()).toHaveLength(0);
    expect(s.listLists()).toEqual(baseline);
    expect(s.undoProposal(listProposal.id).status).toBe("undone");
  });

  it("resolves a generic temporary list and parent reference without leaking writes during save", () => {
    const s = service();
    const saved = s.saveProposal(
      proposal([
        listAction(),
        {
          type: "create",
          temp_id: "parent",
          patch: { list_id: "new-list", title: "Parent" },
        },
        {
          type: "create",
          patch: { list_id: "new-list", parent_id: "parent", title: "Child" },
        },
      ]),
      "",
      "",
      [],
    );
    expect(s.listLists()).toHaveLength(3);
    expect(s.listTasks()).toHaveLength(0);
    s.applyProposal(saved.id, true);
    const [parent, child] = s.listTasks();
    expect(child.parent_id).toBe(parent.id);
    expect(child.list_id).toBe(parent.list_id);
    expect(parent.list_id).not.toBe("new-list");
    s.undoProposal(saved.id);
    expect(s.listLists()).toHaveLength(3);
    expect(s.listTasks()).toHaveLength(0);
  });

  it("rolls back the new list, tasks and list snapshots if a later task fails validation", () => {
    const s = service();
    const saved = s.saveProposal(
      proposal([
        listAction(),
        { type: "create", patch: { list_id: "new-list", title: "Good" } },
        {
          type: "create",
          patch: {
            list_id: "new-list",
            title: "Invalid date tuple",
            due_kind: "date",
          },
        },
      ]),
      "",
      "",
    );
    expect(() => s.applyProposal(saved.id, true)).toThrow();
    expect(s.listLists()).toHaveLength(3);
    expect(s.listTasks()).toHaveLength(0);
    expect(
      s.db.prepare("SELECT COUNT(*) AS n FROM proposal_created_lists").get()!.n,
    ).toBe(0);
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE proposal_id=?")
        .get(saved.id)!.n,
    ).toBe(0);
    expect(s.listProposals()[0].status).toBe("failed");
  });

  it("rejects duplicate active names both at save time and after a competing list appears", () => {
    const s = service();
    s.createList("Existing");
    expect(() =>
      s.saveProposal(proposal([listAction(" existing ")]), "", ""),
    ).toThrow(/this name|Duplicate list name/);
    expect(() =>
      s.saveProposal(
        proposal([listAction("Project"), listAction("project", "other")]),
        "",
        "",
      ),
    ).toThrow(/this name|Duplicate list name/);
    const saved = s.saveProposal(proposal([listAction()]), "", "");
    s.createList("Lazyfish·Codex-WebUI");
    const before = s.listLists();
    expect(() => s.applyProposal(saved.id, true)).toThrow(
      /this name|Duplicate list name/,
    );
    expect(s.listLists()).toEqual(before);
  });

  it("rejects temporary IDs that collide with real list/task identities, including archived entities", () => {
    const s = service();
    const existing = s.createTask({ title: "Existing task" });
    const archived = s.createList("Archived");
    s.deleteList(archived.id);
    s.deleteTask(existing.id, existing.version);
    for (const collision of [s.listLists()[0].id, archived.id, existing.id]) {
      expect(() =>
        s.saveProposal(proposal([listAction("Project", collision)]), "", ""),
      ).toThrow(/Temporary ID|Temporary reference/);
      expect(() =>
        s.saveProposal(
          proposal([
            {
              type: "create",
              temp_id: collision,
              patch: { title: "Task", list_id: s.listLists()[0].id },
            },
          ]),
          "",
          "",
        ),
      ).toThrow(/Temporary ID|Temporary reference/);
    }
  });

  it("refuses undo atomically when a created list is edited, even if its fields are changed back", () => {
    const s = service();
    const saved = s.saveProposal(
      proposal([
        listAction(),
        { type: "create", patch: { title: "Keep", list_id: "new-list" } },
      ]),
      "",
      "",
    );
    s.applyProposal(saved.id, true);
    const list = s.listLists().find((l) => l.name === "Lazyfish·Codex-WebUI")!;
    s.updateList(list.id, { name: "Renamed" });
    s.updateList(list.id, { name: list.name });
    expect(() => s.undoProposal(saved.id)).toThrow(/list changed/);
    expect(s.listTasks()).toHaveLength(1);
    expect(s.listLists()).toHaveLength(4);
    expect(s.listProposals()[0].status).toBe("applied");
  });

  it("restores moved tasks and children before archiving the proposed destination list", () => {
    const s = service();
    const parent = s.createTask({ title: "Parent" });
    const child = s.createTask({
      title: "Child",
      list_id: parent.list_id,
      parent_id: parent.id,
    });
    const saved = s.saveProposal(
      proposal([
        listAction(),
        {
          type: "update",
          target_id: parent.id,
          expected_version: parent.version,
          patch: { list_id: "new-list" },
        },
      ]),
      "",
      "",
      [parent.id],
    );
    s.applyProposal(saved.id, true);
    expect(s.getTask(parent.id).list_id).not.toBe(parent.list_id);
    expect(s.getTask(child.id).list_id).toBe(s.getTask(parent.id).list_id);
    s.undoProposal(saved.id);
    expect(s.getTask(parent.id).list_id).toBe(parent.list_id);
    expect(s.getTask(child.id).list_id).toBe(parent.list_id);
    expect(s.listLists()).toHaveLength(3);
  });

  it("does not restore a historical task into a list that was subsequently undone", () => {
    const s = service();
    const listPlan = s.saveProposal(proposal([listAction()]), "", "");
    s.applyProposal(listPlan.id, true);
    const list = s.listLists().find((l) => l.name === "Lazyfish·Codex-WebUI")!;
    const task = s.createTask({ title: "Later", list_id: list.id });
    const deletion = s.saveProposal(
      proposal(
        [
          {
            type: "delete",
            target_id: task.id,
            expected_version: task.version,
            patch: {},
          },
        ],
        "deletion",
      ),
      "",
      "",
    );
    s.applyProposal(deletion.id, true);
    s.undoProposal(listPlan.id);
    expect(() => s.undoProposal(deletion.id)).toThrow(/original list/);
    expect(s.listTasks()).toHaveLength(0);
    expect(s.listProposals().find((p) => p.id === deletion.id)?.status).toBe(
      "applied",
    );
  });
});
