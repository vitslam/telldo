import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoService } from "../src/main/memo-service";
import { MAX_MEMO_FILE_BYTES } from "../src/shared/memo";

const services: MemoService[] = [];
const directories: string[] = [];
function service() {
  const directory = mkdtempSync(join(tmpdir(), "telldo-memos-"));
  directories.push(directory);
  const instance = new MemoService(directory);
  services.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of services.splice(0)) instance.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aYQAAAAASUVORK5CYII=",
  "base64",
);

describe("local memo originals and timeline", () => {
  it("persists one capture with several original files across reopening without exposing storage paths", async () => {
    const s = service();
    const memo = await s.create({
      text: "展览灵感\n下次可以试试这种配色。",
      attachments: [
        { name: "灵感.png", bytes: png },
        { name: "参考笔记.md", bytes: Buffer.from("完整的原始笔记") },
      ],
    });
    expect(s.list()).toHaveLength(1);
    expect(memo.title).toBe("展览灵感");
    expect(memo.attachments).toHaveLength(2);
    expect(memo.attachments[0]).toMatchObject({
      name: "灵感.png",
      kind: "image",
      mime: "image/png",
      bytes: png.length,
    });
    expect(JSON.stringify(memo)).not.toContain(s.fileDir);
    expect(readFileSync(s.getAttachment(memo.attachments[0].id).path)).toEqual(
      png,
    );
    const reopened = new MemoService(directories.at(-1)!);
    services.push(reopened);
    expect(reopened.get(memo.id)).toEqual(memo);
    expect(
      readFileSync(
        reopened.getAttachment(memo.attachments[1].id).path,
      ).toString(),
    ).toBe("完整的原始笔记");
  });
  it("searches body, extracted text and filenames, without overwriting the original caption", async () => {
    const s = service();
    const memo = await s.create({
      text: "给未来自己的想法",
      attachments: [
        { name: "设计草稿.md", bytes: Buffer.from("留白和灰阶之间的关系") },
      ],
    });
    expect(memo.body).toBe("给未来自己的想法");
    expect(memo.extracted_text).toContain("灰阶");
    for (const query of ["设计草稿", "灰阶", "未来 想法"])
      expect(s.list(query).map((m) => m.id)).toEqual([memo.id]);
    expect(s.list("不存在的词")).toEqual([]);
  });
  it("treats extension-spoofed SVG and HTML as files, while recognizing raster bytes without trusting their extension", async () => {
    const s = service();
    const memo = await s.create({
      text: "",
      attachments: [
        {
          name: "fake.png",
          bytes: Buffer.from('<svg onload="alert(1)"></svg>'),
        },
        { name: "photo.dat", bytes: png },
      ],
    });
    expect(memo.attachments[0]).toMatchObject({
      kind: "file",
      mime: "text/plain",
    });
    expect(memo.attachments[1]).toMatchObject({
      kind: "image",
      mime: "image/png",
    });
    expect(memo.kind).toBe("image");
  });
  it("keeps analysis separate, rejects stale edits and clears stale suggestions after editing captured text", async () => {
    const s = service();
    const original = await s.create({
      text: "原始内容",
      analysis_state: "pending",
    });
    const analyzed = s.setAnalysis(
      original.id,
      {
        title: "AI 标题",
        summary: "AI 摘要",
        analysis_state: "task",
        proposal_id: "proposal-1",
      },
      original.version,
    );
    expect(analyzed.body).toBe("原始内容");
    expect(() =>
      s.update(original.id, original.version, { body: "不能覆盖" }),
    ).toThrow(/changed/);
    const edited = s.update(original.id, analyzed.version, {
      body: "用户重新编辑的原文",
    });
    expect(edited).toMatchObject({
      summary: "",
      proposal_id: null,
      analysis_state: "ready",
    });
    const late = s.setAnalysis(
      original.id,
      { title: "过期结果", analysis_state: "ready" },
      original.version,
    );
    expect(late).toEqual(edited);
  });
  it("removes only the memo from the timeline and attachment access, preserving originals for undo", async () => {
    const s = service();
    const memo = await s.create({
      text: "",
      attachments: [{ name: "photo.png", bytes: png }],
    });
    const path = s.getAttachment(memo.attachments[0].id).path;
    expect(() => s.remove(memo.id, memo.version + 1)).toThrow(/changed/);
    s.remove(memo.id, memo.version);
    expect(s.list()).toEqual([]);
    expect(() => s.getAttachment(memo.attachments[0].id)).toThrow(/not found/);
    expect(readFileSync(path)).toEqual(png);
    expect(s.restore(memo.id).attachments).toEqual(memo.attachments);
    expect(s.getAttachment(memo.attachments[0].id).path).toBe(path);
  });
  it("normalizes display filenames, owns physical filenames, and refuses external-path or symlink access", async () => {
    const s = service();
    const memo = await s.create({
      text: "",
      attachments: [{ name: "../资料/..\\安全\u0000.png", bytes: png }],
    });
    expect(memo.attachments[0].name).toBe("安全.png");
    const attachment = s.getAttachment(memo.attachments[0].id);
    expect(attachment.path).toContain(s.fileDir);
    expect(() => s.getAttachment("../../private-file")).toThrow();
    rmSync(attachment.path);
    const outside = join(directories.at(-1)!, "outside-secret.txt");
    writeFileSync(outside, "not an attachment");
    symlinkSync(outside, attachment.path);
    expect(() => s.getAttachment(memo.attachments[0].id)).toThrow(/path/);
  });
  it("rejects excessive files or text before writing any files", async () => {
    const s = service();
    await expect(
      s.create({
        text: "",
        attachments: [
          { name: "large.bin", bytes: new Uint8Array(MAX_MEMO_FILE_BYTES + 1) },
        ],
      }),
    ).rejects.toThrow(/50 MB/);
    await expect(s.create({ text: " ", attachments: [] })).rejects.toThrow(
      /Write something/,
    );
    await expect(s.create({ text: "a".repeat(1_000_001) })).rejects.toThrow(
      /too long/,
    );
    expect(s.list()).toEqual([]);
    expect(readdirSync(s.fileDir)).toEqual([]);
  });
  it("cleans staged copies if a database write fails, leaving no partial capture", async () => {
    const s = service();
    s.db.exec(
      "CREATE TRIGGER reject_memo BEFORE INSERT ON memos BEGIN SELECT RAISE(ABORT,'disk write failed'); END",
    );
    await expect(
      s.create({
        text: "保存失败",
        attachments: [{ name: "photo.png", bytes: png }],
      }),
    ).rejects.toThrow(/disk write failed/);
    expect(s.list()).toEqual([]);
    expect(readdirSync(s.fileDir)).toEqual([]);
  });
  it("makes concurrent retries idempotent and rejects key reuse for other content", async () => {
    const s = service();
    const input = {
      text: "同一份原文",
      idempotencyKey: "capture-1",
      attachments: [{ name: "photo.png", bytes: png }],
    };
    const [a, b] = await Promise.all([s.create(input), s.create(input)]);
    expect(a.id).toBe(b.id);
    expect(s.list()).toHaveLength(1);
    expect(readdirSync(s.fileDir)).toHaveLength(1);
    await expect(s.create({ ...input, text: "另一份内容" })).rejects.toThrow(
      /key/,
    );
  });
  it("exports portable originals and appends imported captures with new entity IDs and original timeline dates", async () => {
    const s = service();
    const original = await s.create({
      text: "我的原文",
      attachments: [{ name: "tiny.png", bytes: png }],
    });
    const archive = await s.exportData();
    expect(JSON.stringify(archive)).not.toContain(s.fileDir);
    expect(archive.memos[0].attachments[0].base64).toBe(png.toString("base64"));
    const target = service();
    const [imported] = await target.importData(archive);
    expect(imported.id).not.toBe(original.id);
    expect(imported.attachments[0].id).not.toBe(original.attachments[0].id);
    expect(imported).toMatchObject({
      body: original.body,
      title: original.title,
      created_at: original.created_at,
      source: "import",
      proposal_id: null,
    });
    expect(
      readFileSync(target.getAttachment(imported.attachments[0].id).path),
    ).toEqual(png);
  });
  it("rejects noncanonical base64 and detects externally changed originals during export", async () => {
    const s = service();
    const memo = await s.create({
      text: "",
      attachments: [{ name: "data.txt", bytes: Buffer.from("original") }],
    });
    const archive = await s.exportData();
    for (const base64 of ["AB==", "YWJj=", "====", "YWJj\n"]) {
      const invalid = structuredClone(archive);
      invalid.memos[0].attachments[0].base64 = base64;
      expect(() => s.validateArchive(invalid)).toThrow(/Invalid attachment/);
    }
    writeFileSync(s.getAttachment(memo.attachments[0].id).path, "tampered");
    await expect(s.exportData()).rejects.toThrow(/changed outside/);
  });
  it("validates a whole archive before writing anything and rolls back imported captures together", async () => {
    const source = service();
    await source.create({
      text: "a",
      attachments: [{ name: "a.png", bytes: png }],
    });
    await source.create({
      text: "b",
      attachments: [{ name: "b.png", bytes: png }],
    });
    const archive = await source.exportData();
    const target = service();
    const bad = structuredClone(archive);
    bad.memos[1].attachments[0].base64 = "../../invalid-data";
    expect(() => target.validateArchive(bad)).toThrow(/Invalid attachment/);
    await expect(target.importData(bad)).rejects.toThrow(/Invalid attachment/);
    expect(target.list()).toEqual([]);
    expect(readdirSync(target.fileDir)).toEqual([]);
    target.db.exec(
      "CREATE TRIGGER reject_second_memo BEFORE INSERT ON memos WHEN NEW.body='b' BEGIN SELECT RAISE(ABORT,'import blocked'); END",
    );
    await expect(target.importData(archive)).rejects.toThrow(/import blocked/);
    expect(target.list()).toEqual([]);
    expect(readdirSync(target.fileDir)).toEqual([]);
  });
});

describe("unified capture staging and task assets", () => {
  const taskA = "11111111-1111-4111-8111-111111111111";
  const taskB = "22222222-2222-4222-8222-222222222222";
  const proposal = "33333333-3333-4333-8333-333333333333";
  it("keeps a mixed draft hidden until the AI publishes it, preserving caption and original bytes once", async () => {
    const s = service();
    const input = {
      text: "这张图是活动海报，想和说明一起留下。",
      attachments: [{ name: "海报.png", bytes: png }],
      idempotencyKey: "request-a",
    };
    const staged = await s.stage(input);
    expect(staged.staged).toBe(true);
    expect(s.list()).toEqual([]);
    expect(() => s.get(staged.id)).toThrow(/not found/);
    expect(s.get(staged.id, { includeStaged: true }).body).toBe(input.text);
    expect(
      readFileSync(s.getAttachment(staged.attachments[0].id).path),
    ).toEqual(png);
    const retry = await s.stage(input);
    expect(retry.id).toBe(staged.id);
    expect(readdirSync(s.fileDir)).toHaveLength(1);
    const published = s.publish(staged.id, {
      kind: "memo",
      title: "活动海报",
      summary: "活动资料",
      extracted_text: "AI 从图片读取的原文",
    });
    expect(published).toMatchObject({
      staged: false,
      capture_kind: "memo",
      body: input.text,
      extracted_text: "AI 从图片读取的原文",
    });
    expect(s.list()).toHaveLength(1);
    expect((await s.stage(input)).id).toBe(staged.id);
    expect(s.list()).toHaveLength(1);
  });
  it("associates images with tasks idempotently and keeps task originals accessible after removing the timeline record", async () => {
    const s = service();
    const staged = await s.stage({
      text: "按这张图准备材料",
      attachments: [{ name: "材料.png", bytes: png }],
    });
    const attachmentId = staged.attachments[0].id;
    s.linkProposal(staged.id, proposal);
    expect(s.captureForProposal(proposal)?.id).toBe(staged.id);
    s.attachToTask(taskA, [attachmentId, attachmentId]);
    s.linkTaskCapture(staged.id, taskA);
    const published = s.publish(staged.id, { kind: "task" });
    expect(published.task_ids).toEqual([taskA]);
    expect(s.taskAttachments(taskA)).toEqual(staged.attachments);
    expect(s.taskAttachmentMap()[taskA]).toEqual(staged.attachments);
    const path = s.getAttachment(attachmentId).path;
    s.remove(published.id, published.version);
    expect(s.list()).toEqual([]);
    expect(s.getAttachment(attachmentId).path).toBe(path);
    const again = s.publish(staged.id, {
      kind: "task",
      summary: "更改任务关联",
    });
    expect(again.task_ids).toEqual([taskA]);
    expect(s.list()).toEqual([]); // Publishing an association does not restore a deleted timeline record.
    s.detachFromTask(taskA);
    expect(s.taskAttachmentMap()[taskA]).toBeUndefined();
    expect(() => s.getAttachment(attachmentId)).toThrow(/not found/);
    expect(readFileSync(path)).toEqual(png);
  });
  it("tracks text-only task provenance independently from file attachments", async () => {
    const s = service();
    const staged = await s.stage({ text: "明天交设计稿" });
    s.linkTaskCapture(staged.id, taskA);
    const published = s.publish(staged.id, { kind: "task" });
    expect(published.task_ids).toEqual([taskA]);
    expect(s.taskAttachments(taskA)).toEqual([]);
    s.detachFromTask(taskA);
    expect(s.get(published.id).task_ids).toEqual([]);
  });
  it("keeps unresolved proposal captures until explicitly released and safely discards only unsubmitted originals", async () => {
    const s = service();
    const staged = await s.stage({
      text: "草稿",
      attachments: [{ name: "草稿.png", bytes: png }],
    });
    s.linkProposal(staged.id, proposal);
    await expect(s.discard(staged.id)).rejects.toThrow(/still used/);
    s.clearProposal(proposal);
    expect(s.captureForProposal(proposal)).toBeNull();
    await s.discard(staged.id);
    expect(readdirSync(s.fileDir)).toEqual([]);
    expect(() => s.get(staged.id, { includeStaged: true })).toThrow(
      /not found/,
    );
    const published = await s.create({ text: "已收纳" });
    await expect(s.discard(published.id)).rejects.toThrow(/unsubmitted/);
  });
  it("rejects partial or invalid file associations without leaving task links", async () => {
    const s = service();
    const staged = await s.stage({
      text: "",
      attachments: [{ name: "图.png", bytes: png }],
    });
    expect(() =>
      s.attachToTask(taskA, [staged.attachments[0].id, proposal]),
    ).toThrow(/not found/);
    expect(s.taskAttachments(taskA)).toEqual([]);
    expect(s.get(staged.id, { includeStaged: true }).task_ids).toEqual([]);
    expect(() =>
      s.attachToTask("not-a-task", [staged.attachments[0].id]),
    ).toThrow(/Invalid/);
  });
  it("exports linked originals and task provenance without exporting an unsubmitted draft, restoring mapped associations", async () => {
    const s = service();
    await s.stage({ text: "未发送草稿" });
    const capture = await s.stage({
      text: "已安排的资料",
      attachments: [{ name: "图.png", bytes: png }],
    });
    s.attachToTask(taskA, [capture.attachments[0].id]);
    const published = s.publish(capture.id, {
      kind: "task",
      list_id: taskA,
      extracted_text: "图片中的文字",
    });
    s.remove(published.id, published.version);
    const archive = await s.exportData();
    expect(archive.memos).toHaveLength(1);
    expect(archive.memos[0]).toMatchObject({
      body: "已安排的资料",
      capture_kind: "task",
      timeline_hidden: true,
      task_ids: [taskA],
      list_id: taskA,
    });
    const target = service();
    const [imported] = await target.importData(archive, {
      taskIdMap: { [taskA]: taskB },
      listIdMap: { [taskA]: taskB },
    });
    expect(imported.task_ids).toEqual([taskB]);
    expect(imported.list_id).toBe(taskB);
    expect(target.list()).toEqual([]);
    expect(target.taskAttachments(taskB)).toHaveLength(1);
    expect(
      readFileSync(target.getAttachment(imported.attachments[0].id).path),
    ).toEqual(png);
    const fallback = service();
    const [visibleOriginal] = await fallback.importData(archive);
    expect(fallback.list()).toHaveLength(1);
    expect(visibleOriginal.task_ids).toEqual([]);
    expect(visibleOriginal.capture_kind).toBe("memo");
    expect(visibleOriginal.list_id).toBeNull();
  });
  it("preserves published content and typed associations across reopening", async () => {
    const s = service();
    const capture = await s.stage({
      text: "收纳后安排",
      attachments: [{ name: "参考.png", bytes: png }],
    });
    s.linkProposal(capture.id, proposal);
    s.attachToTask(taskA, [capture.attachments[0].id]);
    s.publish(capture.id, { kind: "task" });
    const reopened = new MemoService(directories.at(-1)!);
    services.push(reopened);
    expect(reopened.list()[0].task_ids).toEqual([taskA]);
    expect(reopened.captureForProposal(proposal)?.id).toBe(capture.id);
    expect(reopened.taskAttachments(taskA)).toHaveLength(1);
  });
});
