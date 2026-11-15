export type MemoSource = "memo" | "chat" | "import";
export type MemoAnalysisState = "pending" | "ready" | "task" | "failed";
export interface MemoAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: "image" | "file";
  previewUrl?: string;
}
export interface Memo {
  id: string;
  title: string;
  body: string;
  summary: string;
  extracted_text: string;
  source: MemoSource;
  kind: "text" | "image" | "file";
  created_at: string;
  updated_at: string;
  version: number;
  analysis_state: MemoAnalysisState;
  proposal_id: string | null;
  list_id: string | null;
  capture_kind: "memo" | "task";
  staged: boolean;
  task_ids: string[];
  proposal_status?: "pending" | "applied" | "rejected" | "failed" | "undone";
  attachments: MemoAttachment[];
}
export interface MemoUpload {
  name: string;
  bytes: Uint8Array;
}
export interface MemoCreateInput {
  text: string;
  title?: string;
  source?: MemoSource;
  attachments?: MemoUpload[];
  analysis_state?: MemoAnalysisState;
  idempotencyKey?: string;
  list_id?: string | null;
}
export interface MemoPublishInput {
  kind: "memo" | "task";
  title?: string;
  summary?: string;
  list_id?: string | null;
  extracted_text?: string;
}
export interface MemoImportMaps {
  listIdMap?: Record<string, string>;
  taskIdMap?: Record<string, string>;
}
export interface MemoArchive {
  format: "telldo-memos";
  version: 1;
  memos: {
    title: string;
    body: string;
    summary: string;
    source: MemoSource;
    created_at: string;
    updated_at: string;
    list_id?: string | null;
    capture_kind?: "memo" | "task";
    task_ids?: string[];
    extracted_text?: string;
    timeline_hidden?: boolean;
    attachments: { name: string; base64: string; task_ids?: string[] }[];
  }[];
}
export const MAX_MEMO_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MEMO_BATCH_BYTES = 150 * 1024 * 1024;
export const MAX_MEMO_ATTACHMENTS = 20;
export const MAX_MEMO_TEXT_LENGTH = 1_000_000;
