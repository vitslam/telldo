import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import Database from "./sqlite";
import {
  MAX_MEMO_ATTACHMENTS,
  MAX_MEMO_BATCH_BYTES,
  MAX_MEMO_FILE_BYTES,
  MAX_MEMO_TEXT_LENGTH,
  type Memo,
  type MemoAnalysisState,
  type MemoArchive,
  type MemoAttachment,
  type MemoCreateInput,
  type MemoSource,
  type MemoPublishInput,
  type MemoImportMaps,
} from "../shared/memo";

interface StoredAttachment extends MemoAttachment {
  memo_id: string;
  filename: string;
  sha256: string;
}
interface PreparedAttachment extends StoredAttachment {
  data: Buffer;
}
interface PreparedMemo {
  id: string;
  title: string;
  body: string;
  summary: string;
  source: MemoSource;
  kind: Memo["kind"];
  extracted_text: string;
  created_at: string;
  updated_at: string;
  analysis_state: MemoAnalysisState;
  idempotency_key: string | null;
  payload_hash: string;
  attachments: PreparedAttachment[];
  list_id: string | null;
  capture_kind: "memo" | "task";
  staged: number;
  restore_tasks?: Record<string, string[]>;
  restore_deleted?: boolean;
  restore_capture_tasks?: string[];
}
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const sources = new Set<MemoSource>(["memo", "chat", "import"]);
const states = new Set<MemoAnalysisState>([
  "pending",
  "ready",
  "task",
  "failed",
]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid memo / 备忘录内容无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!allowEmpty && !value.trim())
  )
    throw Error("Invalid memo text or text too long / 备忘录文字为空或过长");
  return value;
}
function displayName(value: unknown): string {
  const name = text(value, 2000)
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  const cleaned = [...name.normalize("NFC")].slice(0, 240).join("");
  return cleaned && cleaned !== "." && cleaned !== ".."
    ? cleaned
    : "Attachment";
}
/** MIME used for previews is established from content, never the provided extension. */
function fileType(data: Buffer): { mime: string; kind: "image" | "file" } {
  const start = data.subarray(0, 32);
  if (
    start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", kind: "image" };
  if (start[0] === 255 && start[1] === 216 && start[2] === 255)
    return { mime: "image/jpeg", kind: "image" };
  if (["GIF87a", "GIF89a"].includes(start.subarray(0, 6).toString("ascii")))
    return { mime: "image/gif", kind: "image" };
  if (
    start.subarray(0, 4).toString("ascii") === "RIFF" &&
    start.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { mime: "image/webp", kind: "image" };
  if (start.subarray(0, 5).toString("ascii") === "%PDF-")
    return { mime: "application/pdf", kind: "file" };
  if (start[0] === 80 && start[1] === 75 && [3, 5, 7].includes(start[2]))
    return { mime: "application/zip", kind: "file" };
  const sample = data.subarray(0, 64 * 1024);
  if (!sample.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample, {
        stream: data.length > sample.length,
      });
      // SVG/HTML intentionally remain a downloadable file, never an image/web preview.
      return { mime: "text/plain", kind: "file" };
    } catch {
      /* Binary file. */
    }
  }
  return { mime: "application/octet-stream", kind: "file" };
}

/** User-owned original captures and files, independently stored from task data. */
export class MemoService {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly fileDir: string;
  constructor(userDataDir: string) {
    const directory = resolve(userDataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.fileDir = join(directory, "memos", "files");
    mkdirSync(this.fileDir, { recursive: true, mode: 0o700 });
    this.dbPath = join(directory, "memos.sqlite");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',extracted_text TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,analysis_state TEXT NOT NULL DEFAULT 'ready',proposal_id TEXT,deleted_at TEXT,idempotency_key TEXT UNIQUE,payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memo_attachments(id TEXT PRIMARY KEY,memo_id TEXT NOT NULL REFERENCES memos(id),name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,kind TEXT NOT NULL,filename TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memos_timeline ON memos(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memo_attachments_owner ON memo_attachments(memo_id);
    `);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(memos)")
        .all()
        .map((row) => row.name),
    );
    for (const [name, definition] of Object.entries({
      list_id: "TEXT",
      capture_kind: "TEXT NOT NULL DEFAULT 'memo'",
      staged: "INTEGER NOT NULL DEFAULT 0",
    })) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE memos ADD COLUMN ${name} ${definition}`);
    }
    if (!columns.has("capture_kind"))
      this.db.exec(
        "UPDATE memos SET capture_kind='task' WHERE analysis_state='task'",
      );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memo_task_attachments(task_id TEXT NOT NULL,attachment_id TEXT NOT NULL REFERENCES memo_attachments(id) ON DELETE CASCADE,PRIMARY KEY(task_id,attachment_id));
      CREATE TABLE IF NOT EXISTS memo_proposals(capture_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,proposal_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,PRIMARY KEY(capture_id,proposal_id));
      CREATE TABLE IF NOT EXISTS memo_capture_tasks(capture_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,task_id TEXT NOT NULL,PRIMARY KEY(capture_id,task_id));
      CREATE INDEX IF NOT EXISTS memo_task_attachments_file ON memo_task_attachments(attachment_id);
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memo_capture_tasks SELECT DISTINCT a.memo_id,t.task_id FROM memo_attachments a JOIN memo_task_attachments t ON t.attachment_id=a.id",
      )
      .run();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memo_proposals(capture_id,proposal_id,created_at) SELECT id,proposal_id,updated_at FROM memos WHERE proposal_id IS NOT NULL",
      )
      .run();
  }
  close() {
    this.db.close();
  }
  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }
  private decode(row: Record<string, any>): Memo {
    const attachments = this.db
      .prepare(
        "SELECT id,name,mime,bytes,kind FROM memo_attachments WHERE memo_id=? ORDER BY rowid",
      )
      .all(row.id) as MemoAttachment[];
    const {
      id,
      title,
      body,
      summary,
      extracted_text,
      source,
      kind,
      created_at,
      updated_at,
      version,
      analysis_state,
      proposal_id,
    } = row;
    return {
      id,
      title,
      body,
      summary,
      extracted_text,
      source,
      kind,
      created_at,
      updated_at,
      version,
      analysis_state,
      proposal_id,
      list_id: row.list_id ?? null,
      capture_kind: row.capture_kind === "task" ? "task" : "memo",
      staged: Boolean(row.staged),
      task_ids: this.db
        .prepare(
          "SELECT task_id FROM memo_capture_tasks WHERE capture_id=? ORDER BY task_id",
        )
        .all(id)
        .map((row) => row.task_id),
      attachments,
    };
  }
  list(query = ""): Memo[] {
    text(query, 2000, true);
    const rows = this.db
      .prepare(
        "SELECT * FROM memos WHERE deleted_at IS NULL AND staged=0 ORDER BY created_at DESC,id DESC",
      )
      .all();
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map((row) => this.decode(row))
      .filter((memo) => {
        if (!words.length) return true;
        const content =
          `${memo.title}\n${memo.body}\n${memo.summary}\n${memo.extracted_text}\n${memo.attachments.map((file) => file.name).join("\n")}`.toLocaleLowerCase();
        return words.every((word) => content.includes(word));
      });
  }
  get(id: string, options: { includeStaged?: boolean } = {}): Memo {
    if (typeof id !== "string" || !uuid(id))
      throw Error("Memo not found / 备忘录不存在");
    const row = this.db
      .prepare(
        `SELECT * FROM memos WHERE id=? AND deleted_at IS NULL ${options.includeStaged ? "" : "AND staged=0"}`,
      )
      .get(id);
    if (!row) throw Error("Memo not found / 备忘录不存在");
    return this.decode(row);
  }
  private prepare(input: MemoCreateInput): PreparedMemo {
    const v = record(input);
    const body = text(v.text ?? "", MAX_MEMO_TEXT_LENGTH, true);
    const source = (v.source ?? "memo") as MemoSource;
    const state = (v.analysis_state ?? "ready") as MemoAnalysisState;
    if (!sources.has(source) || !states.has(state))
      throw Error("Invalid memo source or state");
    const files = v.attachments ?? [];
    if (!Array.isArray(files) || files.length > MAX_MEMO_ATTACHMENTS)
      throw Error(
        `Choose up to ${MAX_MEMO_ATTACHMENTS} files / 单次最多 ${MAX_MEMO_ATTACHMENTS} 个附件`,
      );
    if (!body.trim() && !files.length)
      throw Error("Write something or add a file / 写点内容或添加一个文件");
    let totalBytes = Buffer.byteLength(body);
    const memoId = randomUUID();
    const attachments: PreparedAttachment[] = files.map((raw) => {
      const file = record(raw);
      if (!(file.bytes instanceof Uint8Array))
        throw Error("Invalid file bytes / 附件数据无效");
      if (file.bytes.byteLength > MAX_MEMO_FILE_BYTES)
        throw Error("Each file must be at most 50 MB / 每个文件不能超过 50 MB");
      totalBytes += file.bytes.byteLength;
      if (totalBytes > MAX_MEMO_BATCH_BYTES)
        throw Error("Files exceed 150 MB / 本次附件总大小不能超过 150 MB");
      const data = Buffer.from(file.bytes);
      const name = displayName(file.name);
      const id = randomUUID();
      const extension = extname(name);
      const filename = `${id}${/^\.[a-z0-9]{1,16}$/i.test(extension) ? extension.toLowerCase() : ".bin"}`;
      return {
        id,
        memo_id: memoId,
        name,
        filename,
        bytes: data.length,
        ...fileType(data),
        sha256: hash(data),
        data,
      };
    });
    const firstLine = body
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[#>*-]+\s*/, "").trim())
      .find(Boolean);
    const fallback =
      attachments.length === 1
        ? attachments[0].name
        : attachments.length
          ? `${attachments.length} 个附件`
          : "备忘录";
    const title =
      v.title === undefined
        ? [...(firstLine || fallback)].slice(0, 100).join("")
        : text(v.title, 200).trim();
    const idempotency_key =
      v.idempotencyKey === undefined
        ? null
        : text(v.idempotencyKey, 200).trim();
    const extracted_text = attachments
      .filter((file) => file.mime === "text/plain")
      .map(
        (file) =>
          `${file.name}\n${file.data.subarray(0, 256 * 1024).toString("utf8")}`,
      )
      .join("\n\n")
      .slice(0, 256 * 1024);
    const at = new Date().toISOString();
    const payload_hash = hash(
      JSON.stringify({
        body,
        title,
        source,
        list_id: v.list_id ?? null,
        files: attachments.map((file) => ({
          name: file.name,
          sha256: file.sha256,
        })),
      }),
    );
    return {
      id: memoId,
      title,
      body,
      summary: "",
      source,
      kind: attachments.some((file) => file.kind === "image")
        ? "image"
        : attachments.length
          ? "file"
          : "text",
      extracted_text,
      created_at: at,
      updated_at: at,
      analysis_state: state,
      idempotency_key,
      payload_hash,
      attachments,
      list_id:
        v.list_id === undefined || v.list_id === null
          ? null
          : text(v.list_id, 200).trim(),
      capture_kind: "memo",
      staged: 0,
    };
  }
  private insert(value: PreparedMemo) {
    const {
      attachments,
      restore_tasks,
      restore_deleted,
      restore_capture_tasks,
      ...row
    } = value;
    this.db
      .prepare(
        "INSERT INTO memos(id,title,body,summary,extracted_text,source,kind,created_at,updated_at,analysis_state,idempotency_key,payload_hash,list_id,capture_kind,staged) VALUES(@id,@title,@body,@summary,@extracted_text,@source,@kind,@created_at,@updated_at,@analysis_state,@idempotency_key,@payload_hash,@list_id,@capture_kind,@staged)",
      )
      .run(row);
    const put = this.db.prepare(
      "INSERT INTO memo_attachments(id,memo_id,name,mime,bytes,kind,filename,sha256) VALUES(@id,@memo_id,@name,@mime,@bytes,@kind,@filename,@sha256)",
    );
    for (const file of attachments) {
      put.run(file);
      for (const taskId of restore_tasks?.[file.id] || [])
        this.db
          .prepare("INSERT OR IGNORE INTO memo_task_attachments VALUES(?,?)")
          .run(taskId, file.id);
    }
    for (const taskId of restore_capture_tasks || [])
      this.db
        .prepare("INSERT OR IGNORE INTO memo_capture_tasks VALUES(?,?)")
        .run(value.id, taskId);
    if (restore_deleted)
      this.db
        .prepare("UPDATE memos SET deleted_at=updated_at WHERE id=?")
        .run(value.id);
  }
  private async persist(values: PreparedMemo[]): Promise<void> {
    const written: string[] = [];
    try {
      for (const value of values)
        for (const attachment of value.attachments) {
          const path = join(this.fileDir, attachment.filename);
          await writeFile(path, attachment.data, { flag: "wx", mode: 0o600 });
          written.push(path);
        }
      this.db.transaction(() => {
        for (const value of values) this.insert(value);
      })();
    } catch (error) {
      await Promise.allSettled(
        written.map((path) => rm(path, { force: true })),
      );
      throw error;
    }
  }
  async create(input: MemoCreateInput): Promise<Memo> {
    return this.createContent(input, false);
  }
  async stage(input: MemoCreateInput): Promise<Memo> {
    return this.createContent(input, true);
  }
  private async createContent(
    input: MemoCreateInput,
    staged: boolean,
  ): Promise<Memo> {
    const value = this.prepare(input);
    value.staged = staged ? 1 : 0;
    if (value.idempotency_key) {
      const row = this.db
        .prepare("SELECT * FROM memos WHERE idempotency_key=?")
        .get(value.idempotency_key);
      if (row) {
        if (row.payload_hash !== value.payload_hash)
          throw Error("Capture key already used for different content");
        return this.get(row.id, { includeStaged: true });
      }
    }
    try {
      await this.persist([value]);
    } catch (error) {
      // A concurrent retry may have committed while files were being copied.
      if (value.idempotency_key) {
        const row = this.db
          .prepare("SELECT * FROM memos WHERE idempotency_key=?")
          .get(value.idempotency_key);
        if (row && row.payload_hash === value.payload_hash)
          return this.get(row.id, { includeStaged: true });
      }
      throw error;
    }
    return this.get(value.id, { includeStaged: true });
  }
  update(
    id: string,
    expectedVersion: number,
    patch: { title?: string; body?: string; list_id?: string | null },
  ): Memo {
    const v = record(patch);
    if (
      Object.keys(v).some((key) => !["title", "body", "list_id"].includes(key))
    )
      throw Error("Unknown memo field");
    const current = this.get(id);
    if (current.version !== expectedVersion)
      throw Error(
        "Memo changed. Reopen it and try again / 备忘录已改变，请重新打开后编辑",
      );
    const title =
      v.title === undefined ? current.title : text(v.title, 200).trim();
    const body =
      v.body === undefined
        ? current.body
        : text(v.body, MAX_MEMO_TEXT_LENGTH, true);
    if (!body.trim() && !current.attachments.length)
      throw Error("A memo cannot be empty / 备忘录不能为空");
    const bodyChanged = body !== current.body;
    const listId =
      v.list_id === undefined
        ? current.list_id
        : v.list_id === null
          ? null
          : text(v.list_id, 200).trim();
    this.db
      .prepare(
        "UPDATE memos SET title=?,body=?,summary=?,proposal_id=?,analysis_state=?,list_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL",
      )
      .run(
        title,
        body,
        bodyChanged ? "" : current.summary,
        bodyChanged ? null : current.proposal_id,
        bodyChanged ? "ready" : current.analysis_state,
        listId,
        new Date().toISOString(),
        id,
        expectedVersion,
      );
    return this.get(id);
  }
  setAnalysis(
    id: string,
    patch: {
      title?: string;
      summary?: string;
      proposal_id?: string | null;
      analysis_state: MemoAnalysisState;
    },
    expectedVersion?: number,
  ): Memo {
    const current = this.get(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      return current;
    if (!states.has(patch.analysis_state)) throw Error("Invalid memo state");
    const title =
      patch.title === undefined ? current.title : text(patch.title, 200).trim();
    const summary =
      patch.summary === undefined
        ? current.summary
        : text(patch.summary, 2000, true);
    const proposal =
      patch.proposal_id === undefined
        ? current.proposal_id
        : patch.proposal_id === null
          ? null
          : text(patch.proposal_id, 200).trim();
    // Analysis is metadata: it never rewrites the captured body or files.
    this.db
      .prepare(
        "UPDATE memos SET title=?,summary=?,analysis_state=?,proposal_id=?,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL",
      )
      .run(
        title,
        summary,
        patch.analysis_state,
        proposal,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }
  remove(id: string, expectedVersion: number): void {
    const current = this.get(id);
    if (current.version !== expectedVersion)
      throw Error(
        "Memo changed. Reopen it and try again / 备忘录已改变，请重新打开后删除",
      );
    // Soft deletion keeps original files recoverable, and avoids losing them on a failed write.
    this.db
      .prepare(
        "UPDATE memos SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?",
      )
      .run(
        new Date().toISOString(),
        new Date().toISOString(),
        id,
        expectedVersion,
      );
  }
  restore(id: string): Memo {
    if (
      typeof id !== "string" ||
      !uuid(id) ||
      !this.db.prepare("SELECT 1 FROM memos WHERE id=?").get(id)
    )
      throw Error("Memo not found");
    this.db
      .prepare(
        "UPDATE memos SET deleted_at=NULL,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NOT NULL",
      )
      .run(new Date().toISOString(), id);
    return this.get(id);
  }
  publish(id: string, input: MemoPublishInput): Memo {
    const v = record(input);
    if (v.kind !== "memo" && v.kind !== "task")
      throw Error("Invalid capture kind");
    if (
      Object.keys(v).some(
        (key) =>
          !["kind", "title", "summary", "list_id", "extracted_text"].includes(
            key,
          ),
      )
    )
      throw Error("Unknown capture field");
    const row =
      typeof id === "string" && uuid(id)
        ? this.db.prepare("SELECT * FROM memos WHERE id=?").get(id)
        : undefined;
    if (!row) throw Error("Capture not found / 原始内容不存在");
    const current = this.decode(row);
    const title =
      v.title === undefined ? current.title : text(v.title, 200).trim();
    const summary =
      v.summary === undefined ? current.summary : text(v.summary, 2000, true);
    const listId =
      v.list_id === undefined
        ? current.list_id
        : v.list_id === null
          ? null
          : text(v.list_id, 200).trim();
    const extracted =
      v.extracted_text === undefined
        ? current.extracted_text
        : text(v.extracted_text, MAX_MEMO_TEXT_LENGTH, true);
    // A deleted timeline item stays deleted; associating its files with a task never resurrects it.
    this.db
      .prepare(
        "UPDATE memos SET title=?,summary=?,list_id=?,extracted_text=?,capture_kind=?,staged=0,analysis_state=?,version=version+1,updated_at=? WHERE id=?",
      )
      .run(
        title,
        summary,
        listId,
        extracted,
        v.kind,
        v.kind === "task" ? "task" : "ready",
        new Date().toISOString(),
        id,
      );
    return this.decode(
      this.db.prepare("SELECT * FROM memos WHERE id=?").get(id)!,
    );
  }
  linkProposal(captureId: string, proposalId: string): void {
    if (!uuid(proposalId)) throw Error("Invalid proposal ID");
    this.get(captureId, { includeStaged: true });
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT capture_id FROM memo_proposals WHERE proposal_id=?")
        .get(proposalId);
      if (existing && existing.capture_id !== captureId)
        throw Error("Proposal belongs to another capture");
      this.db
        .prepare("INSERT OR IGNORE INTO memo_proposals VALUES(?,?,?)")
        .run(captureId, proposalId, new Date().toISOString());
      this.db
        .prepare("UPDATE memos SET proposal_id=? WHERE id=?")
        .run(proposalId, captureId);
    })();
  }
  captureForProposal(proposalId: string): Memo | null {
    const row = this.db
      .prepare(
        "SELECT m.* FROM memos m JOIN memo_proposals p ON p.capture_id=m.id WHERE p.proposal_id=?",
      )
      .get(proposalId);
    return row ? this.decode(row) : null;
  }
  clearProposal(proposalId: string): void {
    this.db.transaction(() => {
      const relation = this.db
        .prepare("SELECT capture_id FROM memo_proposals WHERE proposal_id=?")
        .get(proposalId);
      if (!relation) return;
      this.db
        .prepare("DELETE FROM memo_proposals WHERE proposal_id=?")
        .run(proposalId);
      const next = this.db
        .prepare(
          "SELECT proposal_id FROM memo_proposals WHERE capture_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(relation.capture_id);
      this.db
        .prepare("UPDATE memos SET proposal_id=? WHERE id=?")
        .run(next?.proposal_id ?? null, relation.capture_id);
    })();
  }
  linkTaskCapture(captureId: string, taskId: string): void {
    if (
      !uuid(captureId) ||
      !uuid(taskId) ||
      !this.db.prepare("SELECT 1 FROM memos WHERE id=?").get(captureId)
    )
      throw Error("Invalid task capture");
    this.db
      .prepare("INSERT OR IGNORE INTO memo_capture_tasks VALUES(?,?)")
      .run(captureId, taskId);
  }
  attachToTask(taskId: string, attachmentIds: string[]): void {
    if (
      !uuid(taskId) ||
      !Array.isArray(attachmentIds) ||
      attachmentIds.length > MAX_MEMO_ATTACHMENTS
    )
      throw Error("Invalid task attachments");
    const ids = [...new Set(attachmentIds)];
    for (const attachmentId of ids)
      this.getAttachment(attachmentId, { includeDeleted: true });
    this.db.transaction(() => {
      for (const attachmentId of ids) {
        this.db
          .prepare("INSERT OR IGNORE INTO memo_task_attachments VALUES(?,?)")
          .run(taskId, attachmentId);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO memo_capture_tasks SELECT memo_id,? FROM memo_attachments WHERE id=?",
          )
          .run(taskId, attachmentId);
      }
    })();
  }
  detachFromTask(taskId: string, attachmentIds?: string[]): void {
    if (!uuid(taskId)) throw Error("Invalid task ID");
    if (attachmentIds === undefined) {
      this.db.transaction(() => {
        this.db
          .prepare("DELETE FROM memo_task_attachments WHERE task_id=?")
          .run(taskId);
        this.db
          .prepare("DELETE FROM memo_capture_tasks WHERE task_id=?")
          .run(taskId);
      })();
      return;
    }
    if (
      !Array.isArray(attachmentIds) ||
      attachmentIds.some((id) => typeof id !== "string" || !uuid(id))
    )
      throw Error("Invalid attachment IDs");
    this.db.transaction(() => {
      for (const id of attachmentIds)
        this.db
          .prepare(
            "DELETE FROM memo_task_attachments WHERE task_id=? AND attachment_id=?",
          )
          .run(taskId, id);
    })();
  }
  taskAttachments(taskId: string): MemoAttachment[] {
    return this.db
      .prepare(
        "SELECT a.id,a.name,a.mime,a.bytes,a.kind FROM memo_attachments a JOIN memo_task_attachments ta ON ta.attachment_id=a.id WHERE ta.task_id=? ORDER BY a.rowid",
      )
      .all(taskId) as MemoAttachment[];
  }
  taskAttachmentMap(): Record<string, MemoAttachment[]> {
    const result: Record<string, MemoAttachment[]> = Object.create(null);
    const rows = this.db
      .prepare(
        "SELECT ta.task_id,a.id,a.name,a.mime,a.bytes,a.kind FROM memo_attachments a JOIN memo_task_attachments ta ON ta.attachment_id=a.id ORDER BY a.rowid",
      )
      .all();
    for (const { task_id, ...attachment } of rows)
      (result[task_id] ??= []).push(attachment as MemoAttachment);
    return result;
  }
  async discard(id: string): Promise<void> {
    const memo = this.get(id, { includeStaged: true });
    if (!memo.staged)
      throw Error("Only an unsubmitted capture can be discarded");
    const files = this.db
      .prepare("SELECT id,filename FROM memo_attachments WHERE memo_id=?")
      .all(id);
    if (
      this.db
        .prepare("SELECT 1 FROM memo_capture_tasks WHERE capture_id=? LIMIT 1")
        .get(id) ||
      this.db
        .prepare("SELECT 1 FROM memo_proposals WHERE capture_id=? LIMIT 1")
        .get(id) ||
      this.db
        .prepare(
          "SELECT 1 FROM memo_task_attachments t JOIN memo_attachments a ON a.id=t.attachment_id WHERE a.memo_id=? LIMIT 1",
        )
        .get(id)
    )
      throw Error("Capture is still used by a task or proposal");
    const paths = files.map((file) => this.getAttachment(file.id).path);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memo_attachments WHERE memo_id=?").run(id);
      this.db.prepare("DELETE FROM memos WHERE id=?").run(id);
    })();
    await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
  }
  getAttachment(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): {
    path: string;
    name: string;
    mime: string;
    bytes: number;
    kind: "image" | "file";
  } {
    if (typeof id !== "string" || !uuid(id))
      throw Error("Attachment not found / 附件不存在");
    const file = this.db
      .prepare(
        `SELECT a.* FROM memo_attachments a JOIN memos m ON m.id=a.memo_id WHERE a.id=? AND ${options.includeDeleted ? "1=1" : "(m.deleted_at IS NULL OR EXISTS(SELECT 1 FROM memo_task_attachments ta WHERE ta.attachment_id=a.id))"}`,
      )
      .get(id) as StoredAttachment | undefined;
    if (
      !file ||
      !/^[0-9a-f-]{36}\.[a-z0-9]{1,16}$/i.test(file.filename) ||
      !file.filename.startsWith(id)
    )
      throw Error("Attachment not found / 附件不存在");
    const path = realpathSync(join(this.fileDir, file.filename));
    const inside = relative(realpathSync(this.fileDir), path);
    if (
      !inside ||
      inside.startsWith(`..${sep}`) ||
      inside === ".." ||
      resolve(this.fileDir, inside) !== path ||
      !statSync(path).isFile()
    )
      throw Error("Invalid attachment path");
    return {
      path,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      kind: file.kind,
    };
  }
  async exportData(): Promise<MemoArchive> {
    const memos: MemoArchive["memos"] = [];
    let total = 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM memos m WHERE (m.staged=0 AND m.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM memo_capture_tasks t WHERE t.capture_id=m.id) ORDER BY m.created_at,m.id",
      )
      .all();
    for (const row of rows) {
      const memo = this.decode(row);
      const attachments: MemoArchive["memos"][number]["attachments"] = [];
      total +=
        Buffer.byteLength(memo.body) + Buffer.byteLength(memo.extracted_text);
      if (total > MAX_MEMO_BATCH_BYTES)
        throw Error("Memo export exceeds 150 MB / 备忘录导出超过 150 MB");
      for (const attachment of memo.attachments) {
        const data = await readFile(this.getAttachment(attachment.id).path);
        const stored = this.db
          .prepare("SELECT sha256 FROM memo_attachments WHERE id=?")
          .get(attachment.id)!;
        if (data.length !== attachment.bytes || hash(data) !== stored.sha256)
          throw Error(
            "An attachment changed outside Telldo / 附件原件已被外部修改",
          );
        total += data.length;
        if (total > MAX_MEMO_BATCH_BYTES)
          throw Error(
            "Memo export exceeds 150 MB. Export fewer items / 备忘录导出超过 150 MB",
          );
        attachments.push({
          name: attachment.name,
          base64: data.toString("base64"),
          task_ids: this.db
            .prepare(
              "SELECT task_id FROM memo_task_attachments WHERE attachment_id=? ORDER BY task_id",
            )
            .all(attachment.id)
            .map((row) => row.task_id),
        });
      }
      memos.push({
        title: memo.title,
        body: memo.body,
        summary: memo.summary,
        source: memo.source,
        created_at: memo.created_at,
        updated_at: memo.updated_at,
        list_id: memo.list_id,
        capture_kind: memo.capture_kind,
        task_ids: memo.task_ids,
        extracted_text: memo.extracted_text,
        timeline_hidden: Boolean(row.deleted_at || row.staged),
        attachments,
      });
    }
    return { format: "telldo-memos", version: 1, memos };
  }
  private prepareArchive(
    value: unknown,
    maps: MemoImportMaps = {},
  ): PreparedMemo[] {
    const archive = record(value);
    if (
      archive.format !== "telldo-memos" ||
      archive.version !== 1 ||
      !Array.isArray(archive.memos) ||
      archive.memos.length > 10000
    )
      throw Error("Invalid memo archive / 备忘录备份格式无效");
    let total = 0;
    return archive.memos.map((raw) => {
      const v = record(raw);
      const body = text(v.body, MAX_MEMO_TEXT_LENGTH, true);
      const title = text(v.title, 200);
      const summary = text(v.summary ?? "", 2000, true);
      if (
        !Array.isArray(v.attachments) ||
        v.attachments.length > MAX_MEMO_ATTACHMENTS
      )
        throw Error("Invalid archived attachments");
      total += Buffer.byteLength(body);
      const attachments = v.attachments.map((raw) => {
        const f = record(raw);
        if (
          typeof f.base64 !== "string" ||
          f.base64.length > Math.ceil(MAX_MEMO_FILE_BYTES / 3) * 4 ||
          f.base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)
        )
          throw Error("Invalid attachment data in memo archive");
        const padding = f.base64.endsWith("==")
          ? 2
          : f.base64.endsWith("=")
            ? 1
            : 0;
        const byteLength = (f.base64.length / 4) * 3 - padding;
        if (
          byteLength > MAX_MEMO_FILE_BYTES ||
          total + byteLength > MAX_MEMO_BATCH_BYTES
        )
          throw Error("Memo archive exceeds 150 MB or file exceeds 50 MB");
        const bytes = Buffer.from(f.base64, "base64");
        if (
          bytes.length !== byteLength ||
          bytes.toString("base64") !== f.base64
        )
          throw Error("Invalid attachment data in memo archive");
        total += bytes.length;
        if (total > MAX_MEMO_BATCH_BYTES)
          throw Error("Memo archive exceeds 150 MB / 备忘录备份超过 150 MB");
        return { name: displayName(f.name), bytes };
      });
      if (total > MAX_MEMO_BATCH_BYTES)
        throw Error("Memo archive exceeds 150 MB");
      const prepared = this.prepare({
        text: body,
        title,
        source: "import",
        attachments,
      });
      prepared.summary = summary;
      if (
        v.capture_kind !== undefined &&
        !["memo", "task"].includes(String(v.capture_kind))
      )
        throw Error("Invalid archived capture kind");
      if (v.list_id !== undefined && v.list_id !== null) text(v.list_id, 200);
      prepared.capture_kind = v.capture_kind === "task" ? "task" : "memo";
      prepared.list_id =
        typeof v.list_id === "string"
          ? (maps.listIdMap?.[v.list_id] ?? null)
          : null;
      if (prepared.list_id !== null) text(prepared.list_id, 200);
      if (v.extracted_text !== undefined) {
        prepared.extracted_text = text(
          v.extracted_text,
          MAX_MEMO_TEXT_LENGTH,
          true,
        );
        total += Buffer.byteLength(prepared.extracted_text);
        if (total > MAX_MEMO_BATCH_BYTES)
          throw Error("Memo archive exceeds 150 MB");
      }
      prepared.restore_tasks = {};
      for (const [index, rawAttachment] of v.attachments.entries()) {
        const source = record(rawAttachment);
        if (
          source.task_ids !== undefined &&
          (!Array.isArray(source.task_ids) ||
            source.task_ids.length > 10000 ||
            source.task_ids.some((id) => typeof id !== "string" || !uuid(id)))
        )
          throw Error("Invalid archived task attachments");
        const taskIds = ((source.task_ids as string[]) || []).flatMap(
          (oldId) => (maps.taskIdMap?.[oldId] ? [maps.taskIdMap[oldId]] : []),
        );
        if (taskIds.some((id) => !uuid(id)))
          throw Error("Invalid restored task ID");
        prepared.restore_tasks[prepared.attachments[index].id] = [
          ...new Set(taskIds),
        ];
      }
      if (
        v.task_ids !== undefined &&
        (!Array.isArray(v.task_ids) ||
          v.task_ids.length > 10000 ||
          v.task_ids.some((id) => typeof id !== "string" || !uuid(id)))
      )
        throw Error("Invalid archived task captures");
      const taskIds = ((v.task_ids as string[]) || []).flatMap((oldId) =>
        maps.taskIdMap?.[oldId] ? [maps.taskIdMap[oldId]] : [],
      );
      if (taskIds.some((id) => !uuid(id)))
        throw Error("Invalid restored task ID");
      prepared.restore_capture_tasks = [
        ...new Set([
          ...taskIds,
          ...Object.values(prepared.restore_tasks).flat(),
        ]),
      ];
      const hasMappedTasks = prepared.restore_capture_tasks.length > 0;
      if (!hasMappedTasks) prepared.capture_kind = "memo";
      prepared.restore_deleted = v.timeline_hidden === true && hasMappedTasks;
      for (const key of ["created_at", "updated_at"] as const) {
        if (
          typeof v[key] !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T/.test(v[key]) ||
          !Number.isFinite(Date.parse(v[key]))
        )
          throw Error("Invalid memo archive date");
        prepared[key] = new Date(v[key]).toISOString();
      }
      return prepared;
    });
  }
  validateArchive(value: unknown): void {
    this.prepareArchive(value);
  }
  async importData(value: unknown, maps: MemoImportMaps = {}): Promise<Memo[]> {
    const prepared = this.prepareArchive(value, maps);
    await this.persist(prepared);
    return prepared.map((value) =>
      this.decode(
        this.db.prepare("SELECT * FROM memos WHERE id=?").get(value.id)!,
      ),
    );
  }
}
