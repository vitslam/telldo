import { z } from "zod";
import type Database from "./sqlite";
import type { ChatHistoryPage, ChatSession, ConversationMessage } from "../shared/chat-history";

const id = z.string().min(1).max(200);
const text = z.string().max(200000);
const attachment = z.object({
  id, name: z.string().max(1000), kind: z.enum(["image", "file"]),
  bytes: z.number().nonnegative().optional(),
  // Renderer blob URLs only live for a draft. Never revive arbitrary external URLs.
  previewUrl: z.string().transform(value =>
    /^telldo-memo:\/\/attachment\/[a-zA-Z0-9-]+$/.test(value) ? value : undefined,
  ).optional(),
});
const source = z.object({
  kind: z.enum(["task", "memo"]), id, title: text,
  text: text.optional(), listName: text.optional(),
  status: z.enum(["todo", "done"]).optional(), dueDate: id.optional(),
  dueAt: id.optional(), timeZone: id.optional(), createdAt: id.optional(),
  attachments: z.array(attachment).max(100).optional(),
});
const message = z.object({
  id, role: z.enum(["user", "assistant"]), content: text,
  sources: z.array(source).max(100).optional(),
  appliedProposalIds: z.array(id).max(100).optional(),
  memoId: id.optional(), memoIds: z.array(id).max(100).optional(),
  proposalId: id.optional(), captureId: id.optional(), error: z.boolean().optional(),
  attachments: z.array(attachment).max(100).optional(),
  references: z.array(z.object({
    kind: z.enum(["memo", "task"]), id, title: text,
    attachmentCount: z.number().nonnegative().optional(), asTask: z.boolean().optional(),
  })).max(100).optional(),
  turnId: id.optional(), notice: text.optional(),
  // Only the public progress envelope is persisted, never arbitrary tool payloads.
  activities: z.array(z.object({
    type: z.literal("activity"), id,
    phase: z.enum(["context", "connection", "model", "response", "validation"]),
    status: z.enum(["running", "completed"]), label: text,
    detail: text.optional(), text: text.optional(),
  })).max(1000).optional(),
  state: z.enum(["working", "completed", "cancelled", "error"]).optional(),
  startedAt: z.number().finite().optional(), finishedAt: z.number().finite().optional(),
});
const messagesSchema = z.array(message).max(2000);
const short = (value: string, length: number) => value.replace(/\s+/g, " ").trim().slice(0, length);

export class ChatHistory {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, preview TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, messages_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS chat_sessions_recent ON chat_sessions(updated_at DESC)`);
  }
  save(sessionId: unknown, supplied: unknown): void {
    const key = z.uuid().parse(sessionId);
    const messages = messagesSchema.parse(supplied);
    if (!messages.length) return; // Opening a fresh chat cannot erase an older one.
    const json = JSON.stringify(messages);
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw Error("Chat is too large to save / 对话过大，未能保存");
    const first = messages.find(item => item.role === "user");
    const title = short(first?.content || first?.attachments?.[0]?.name || first?.references?.[0]?.title || "Telldo", 80) || "Telldo";
    const preview = short([...messages].reverse().find(item => item.content.trim())?.content || "", 160);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO chat_sessions(id,title,preview,created_at,updated_at,messages_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,preview=excluded.preview,updated_at=excluded.updated_at,messages_json=excluded.messages_json`)
      .run(key, title, preview, now, now, json);
  }
  list(options: unknown = {}): ChatHistoryPage {
    const { query, offset } = z.object({
      query: z.string().max(200).default(""), offset: z.number().int().min(0).max(1000000).default(0),
    }).parse(options);
    const needle = query.trim();
    // Literal substring matching; selecting history does not load all message bodies.
    const where = "WHERE (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(preview),lower(?))>0)";
    const parameters = [needle, needle, needle];
    const total = this.db.prepare(`SELECT count(*) AS count FROM chat_sessions ${where}`).get(...parameters)!.count as number;
    const items = this.db.prepare(`SELECT id,title,preview,created_at AS createdAt,updated_at AS updatedAt
      FROM chat_sessions ${where} ORDER BY updated_at DESC,id DESC LIMIT 50 OFFSET ?`).all(...parameters, offset) as ChatHistoryPage["items"];
    return { items, total, hasMore: offset + items.length < total };
  }
  load(sessionId: unknown): ChatSession | null {
    const key = z.uuid().parse(sessionId);
    const row = this.db.prepare(`SELECT id,title,preview,created_at AS createdAt,updated_at AS updatedAt,messages_json
      FROM chat_sessions WHERE id=?`).get(key);
    if (!row) return null;
    const messages: ConversationMessage[] = messagesSchema.parse(JSON.parse(row.messages_json)).map(item =>
      item.state === "working" ? {
        ...item, state: "cancelled", finishedAt: item.finishedAt ?? Date.now(),
        notice: "上次对话已中断，可继续发送消息。 / This reply was interrupted. You can continue the conversation.",
        activities: item.activities?.map(activity => ({ ...activity, status: "completed" })),
      } : item,
    );
    return { id: row.id, title: row.title, preview: row.preview, createdAt: row.createdAt, updatedAt: row.updatedAt, messages };
  }
}
