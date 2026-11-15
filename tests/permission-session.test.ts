import { afterEach, describe, expect, it } from "vitest";
import { TaskService } from "../src/main/task-service";
import { PermissionSession } from "../src/main/permission-session";
import type { ProposalInput } from "../src/shared/types";
const services: TaskService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
function fixture() {
  const service = new TaskService(":memory:");
  services.push(service);
  let index = 0;
  const make = () =>
    service.saveProposal(
      {
        version: 1,
        summary: "Create task",
        risk: "low",
        idempotency_key: `step-${++index}`,
        actions: [
          {
            type: "create",
            temp_id: `task-${index}`,
            patch: {
              title: `Task ${index}`,
              list_id: service.listLists()[0].id,
            },
          },
        ],
      },
      "Create task",
      "{}",
      [],
    );
  return { service, make };
}
describe("Telldo permission session", () => {
  it("defaults old preferences to confirmation and validates persisted modes atomically", () => {
    const { service } = fixture();
    service.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run("preferences", JSON.stringify({ alwaysConfirm: false }));
    expect(service.getSettings().permissionMode).toBe("confirm");
    expect(service.setSettings({ permissionMode: "auto" }).permissionMode).toBe(
      "auto",
    );
    expect(() =>
      service.setSettings({ permissionMode: "full_access" } as any),
    ).toThrow();
    expect(service.getSettings().permissionMode).toBe("auto");
  });
  it("confirmation mode keeps a proposal pending without invoking its apply callback", () => {
    const { service, make } = fixture();
    const proposal = make();
    const session = new PermissionSession("confirm", () => false);
    const result = session.apply(proposal, () => {
      throw Error("Must not run");
    });
    expect(result.kind).toBe("pending");
    expect(service.listTasks()).toHaveLength(0);
    expect(service.listProposals()[0].status).toBe("pending");
  });
  it("auto mode applies separate proposals in order and retains their IDs", () => {
    const { service, make } = fixture();
    const session = new PermissionSession("auto", () => false);
    for (let i = 0; i < 2; i++) {
      const proposal = make();
      expect(
        session.apply(proposal, () => service.applyProposal(proposal.id, true))
          .kind,
      ).toBe("applied");
    }
    expect(service.listTasks()).toHaveLength(2);
    expect(session.appliedProposalIds).toHaveLength(2);
  });
  it("cancel between steps preserves prior changes and prevents the next mutation", () => {
    const { service, make } = fixture();
    let cancelled = false;
    const session = new PermissionSession("auto", () => cancelled);
    const first = make();
    session.apply(first, () => service.applyProposal(first.id, true));
    cancelled = true;
    const next = make();
    expect(() =>
      session.apply(next, () => service.applyProposal(next.id, true)),
    ).toThrow(/Cancelled/);
    expect(service.listTasks()).toHaveLength(1);
    expect(session.appliedProposalIds).toEqual([first.id]);
    expect(service.listProposals().find((p) => p.id === next.id)?.status).toBe(
      "pending",
    );
  });
  it("keeps the ninth proposal pending once eight automatic changes are applied", () => {
    const { service, make } = fixture();
    const session = new PermissionSession("auto", () => false);
    for (let i = 0; i < 8; i++) {
      const proposal = make();
      session.apply(proposal, () => service.applyProposal(proposal.id, true));
    }
    const next = make();
    expect(
      session.apply(next, () => service.applyProposal(next.id, true)).kind,
    ).toBe("limit");
    expect(service.listTasks()).toHaveLength(8);
    expect(service.listProposals().find((p) => p.id === next.id)?.status).toBe(
      "pending",
    );
  });
  it("does not repeat an applied idempotent proposal", () => {
    const { service, make } = fixture();
    const session = new PermissionSession("auto", () => false);
    const proposal = make();
    const applied = session.apply(proposal, () =>
      service.applyProposal(proposal.id, true),
    ).proposal;
    expect(
      session.apply(applied, () => {
        throw Error("Must not run");
      }).kind,
    ).toBe("duplicate");
    expect(service.listTasks()).toHaveLength(1);
    expect(session.appliedProposalIds).toEqual([proposal.id]);
  });
  it("retains applied IDs when a later proposal fails its version checks", () => {
    const { service, make } = fixture();
    const session = new PermissionSession("auto", () => false);
    const first = make();
    session.apply(first, () => service.applyProposal(first.id, true));
    const task = service.listTasks()[0];
    const body: ProposalInput = {
      version: 1,
      summary: "Rename",
      risk: "high",
      idempotency_key: "rename",
      actions: [
        {
          type: "update",
          target_id: task.id,
          expected_version: task.version,
          patch: { title: "New title" },
        },
      ],
    };
    const proposal = service.saveProposal(body, "Rename", "{}", [task.id]);
    service.updateTask(task.id, task.version, { notes: "Changed elsewhere" });
    expect(() =>
      session.apply(proposal, () => service.applyProposal(proposal.id, true)),
    ).toThrow();
    expect(session.appliedProposalIds).toEqual([first.id]);
    expect(service.getTask(task.id).title).toBe(task.title);
  });
});
