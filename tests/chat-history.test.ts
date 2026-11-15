import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../src/main/sqlite";
import { ChatHistory } from "../src/main/chat-history";

const databases: Database.Database[] = [];
const folders: string[] = [];
const open = (path = ":memory:") => {
  const db = new Database(path);
  databases.push(db);
  return new ChatHistory(db);
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
describe("local conversation history", () => {
  it("persists independent sessions across reopen; a fresh chat cannot erase one", () => {
    const folder = mkdtempSync(join(tmpdir(), "telldo-chat-"));
    folders.push(folder);
    const path = join(folder, "history.sqlite");
    const history = open(path), a = randomUUID(), b = randomUUID();
    history.save(a, [{ id: "u1", role: "user", content: "明天交周报" }]);
    const createdAt = history.load(a)!.createdAt;
    history.save(b, [{ id: "u2", role: "user", content: "查询生活待办" }]);
    history.save(a, []);
    history.save(a, [{ id: "u1", role: "user", content: "明天交周报" }, { id: "a1", role: "assistant", content: "已添加", state: "completed", appliedProposalIds: ["p1"] }]);
    databases.pop()!.close();
    const restored = open(path);
    expect(restored.load(a)?.messages).toHaveLength(2);
    expect(restored.load(a)?.createdAt).toBe(createdAt);
    expect(restored.load(b)?.messages[0].content).toBe("查询生活待办");
    expect(restored.list().total).toBe(2);
  });
  it("retains public reply details, source IDs and local image previews; interrupted turns never resume", () => {
    const history = open(), id = randomUUID();
    history.save(id, [
      { id: "u1", role: "user", content: "", captureId: "memo-1", attachments: [{ id: "image-1", name: "screen.png", kind: "image", previewUrl: "telldo-memo://attachment/image-1" }, { id: "image-2", name: "draft.png", kind: "image", previewUrl: "blob:expired" }] },
      { id: "a1", role: "assistant", content: "已找到", state: "working", startedAt: 123, appliedProposalIds: ["applied-1"], sources: [{ kind: "task", id: "task-1", title: "Review", status: "todo" }], activities: [{ type: "activity", id: "response", phase: "response", status: "running", label: "生成回复", text: "我先查看附件。", rawReasoning: "must be discarded" }] },
    ]);
    const session = history.load(id)!;
    expect(session.title).toBe("screen.png");
    expect(session.messages[0].attachments?.[0].previewUrl).toBe("telldo-memo://attachment/image-1");
    expect(session.messages[0].attachments?.[1].previewUrl).toBeUndefined();
    expect(session.messages[1]).toMatchObject({ state: "cancelled", content: "已找到", appliedProposalIds: ["applied-1"], sources: [{ id: "task-1" }] });
    expect(session.messages[1].activities?.[0]).toMatchObject({ status: "completed", text: "我先查看附件。" });
    expect(session.messages[1].activities?.[0]).not.toHaveProperty("rawReasoning");
  });
  it("paginates summaries without message bodies and treats search as literal text", () => {
    const history = open();
    for (let i = 0; i < 53; i++) history.save(randomUUID(), [{ id: "u", role: "user", content: `对话 ${i}` }]);
    const first = history.list(), second = history.list({ offset: 50 });
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    expect(first.items[0]).not.toHaveProperty("messages");
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(53);
    expect(history.list({ query: "对话 52" }).total).toBe(1);
    expect(history.list({ query: "%" }).total).toBe(0);
  });
  it("rejects malformed writes without replacing a valid session", () => {
    const history = open(), id = randomUUID();
    history.save(id, [{ id: "u", role: "user", content: "Keep me" }]);
    expect(() => history.save(id, [{ role: "system", content: "replace" }])).toThrow();
    expect(() => history.save("not-a-session", [])).toThrow();
    expect(history.load(id)?.messages[0].content).toBe("Keep me");
  });
});
