import type { AIActivity } from "./ai-progress";
export interface ChatSource {
  kind: "task" | "memo";
  id: string;
  title: string;
  text?: string;
  listName?: string;
  status?: "todo" | "done";
  dueDate?: string;
  dueAt?: string;
  timeZone?: string;
  createdAt?: string;
  attachments?: {
    id: string;
    name: string;
    kind: "image" | "file";
    previewUrl?: string;
  }[];
}
export interface ChatMessage {
  sources?: ChatSource[];
  appliedProposalIds?: string[];
  id: string;
  role: "user" | "assistant";
  content: string;
  memoId?: string;
  memoIds?: string[];
  proposalId?: string;
  captureId?: string;
  error?: boolean;
}
export interface ChatReply {
  sources?: ChatSource[];
  appliedProposalIds?: string[];
  activities?: AIActivity[];
  kind: "answer" | "proposal" | "memo";
  memoId?: string;
  memoIds?: string[];
  message: string;
  captureId?: string;
  attachments?: {
    id: string;
    name: string;
    kind: "image" | "file";
    previewUrl?: string;
  }[];
  proposalId?: string;
}
export function conversationContext(context: Record<string, unknown>) {
  // Keep the newest bounded context, not 12 independent 2K payloads.
  const history: { role: string; content: string }[] = [];
  let historyBudget = 6000;
  const suppliedHistory = Array.isArray(context.conversation)
    ? context.conversation.slice(-12)
    : [];
  for (const value of [...suppliedHistory].reverse()) {
    if (
      !value ||
      !["user", "assistant"].includes(value.role) ||
      typeof value.content !== "string" ||
      !historyBudget
    )
      continue;
    const content = value.content.slice(0, Math.min(2000, historyBudget));
    historyBudget -= content.length;
    history.unshift({ role: value.role, content });
  }
  const supplied = context.continuation as Record<string, unknown> | undefined;
  const continuation =
    supplied &&
    typeof supplied === "object" &&
    supplied.status === "applied" &&
    typeof supplied.proposalId === "string" &&
    supplied.proposalId.trim().length > 0 &&
    supplied.proposalId.length <= 200 &&
    typeof supplied.summary === "string"
      ? {
          proposalId: supplied.proposalId,
          status: "applied" as const,
          summary: supplied.summary.slice(0, 2000),
        }
      : undefined;
  const boundedText = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const attachmentMetadata = (value: unknown) =>
    Array.isArray(value)
      ? value
          .slice(0, 12)
          .filter(
            (x) => x && typeof x === "object" && typeof x.name === "string",
          )
          .map((x) => ({
            ...(typeof x.id === "string" ? { id: boundedText(x.id, 200) } : {}),
            name: boundedText(x.name, 300),
            kind: x.kind === "image" ? "image" : "file",
            ...(typeof x.mime === "string"
              ? { mime: boundedText(x.mime, 100) }
              : {}),
            ...(Number.isSafeInteger(x.bytes) && x.bytes >= 0
              ? { bytes: Math.min(x.bytes, 1000000000) }
              : {}),
          }))
      : [];
  const memoInventory = context.memoInventory as
    Record<string, unknown> | undefined;
  const inventory =
    memoInventory &&
    Number.isSafeInteger(memoInventory.total) &&
    Number(memoInventory.total) >= 0
      ? {
          total: Math.min(Number(memoInventory.total), 1000000000),
          included: Number.isSafeInteger(memoInventory.included)
            ? Math.max(
                0,
                Math.min(
                  Number(memoInventory.included),
                  Number(memoInventory.total),
                  12,
                ),
              )
            : 0,
        }
      : undefined;
  const memoSearchResults = Array.isArray(context.memoSearchResults)
    ? context.memoSearchResults
        .slice(0, 12)
        .filter(
          (x) =>
            x &&
            typeof x === "object" &&
            typeof x.id === "string" &&
            x.id.length > 0 &&
            x.id.length <= 200,
        )
        .map((x) => ({
          id: x.id,
          title: boundedText(x.title, 200),
          body: boundedText(x.body, 4000),
          summary: boundedText(x.summary, 500),
          created_at: boundedText(x.created_at, 50),
          attachments: attachmentMetadata(x.attachments),
        }))
    : undefined;
  const capture = context.capture as Record<string, unknown> | undefined;
  const boundedCapture =
    capture &&
    typeof capture === "object" &&
    typeof capture.memoId === "string" &&
    capture.memoId.length > 0 &&
    capture.memoId.length <= 200
      ? {
          memoId: capture.memoId,
          title: boundedText(capture.title, 200),
          text: boundedText(capture.text, 12000),
          attachments: attachmentMetadata(capture.attachments),
        }
      : undefined;
  const phase = ["plan", "result", "referenced"].includes(
    String(context.contextPhase),
  )
    ? context.contextPhase
    : undefined;
  const rawReadBudget = context.contextReadBudget as
    Record<string, unknown> | undefined;
  const readBudget =
    rawReadBudget &&
    Number.isInteger(rawReadBudget.remaining) &&
    Number(rawReadBudget.remaining) >= 0 &&
    Number(rawReadBudget.remaining) <= 2
      ? {
          remaining: Number(rawReadBudget.remaining),
          ...(Number.isInteger(rawReadBudget.used) &&
          Number(rawReadBudget.used) >= 0 &&
          Number(rawReadBudget.used) <= 2
            ? { used: Number(rawReadBudget.used) }
            : {}),
          max: 2,
        }
      : undefined;
  const rawResult = context.queryResult as Record<string, unknown> | undefined;
  const count = (value: unknown, max = 1000000000) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, max)
      : undefined;
  const filters =
    rawResult?.filters && typeof rawResult.filters === "object"
      ? (rawResult.filters as Record<string, unknown>)
      : {};
  const queryResult =
    rawResult &&
    ["tasks", "memos", "schedule", "record"].includes(
      String(rawResult.entity),
    ) &&
    count(rawResult.total) !== undefined &&
    count(rawResult.returned, 30) !== undefined
      ? {
          entity: rawResult.entity,
          filters: {
            ...(typeof filters.keywords === "string"
              ? { keywords: boundedText(filters.keywords, 200) }
              : {}),
            ...(["todo", "done", "all"].includes(String(filters.status))
              ? { status: filters.status }
              : {}),
            ...(typeof filters.list_id === "string"
              ? { list_id: boundedText(filters.list_id, 200) }
              : {}),
            ...(typeof filters.from === "string"
              ? { from: boundedText(filters.from, 10) }
              : {}),
            ...(typeof filters.to === "string"
              ? { to: boundedText(filters.to, 10) }
              : {}),
            ...(["task", "memo"].includes(String(filters.kind))
              ? { kind: filters.kind }
              : {}),
            ...(typeof filters.id === "string"
              ? { id: boundedText(filters.id, 200) }
              : {}),
          },
          total: count(rawResult.total)!,
          returned: count(rawResult.returned, 30)!,
          ...(count(rawResult.limit, 30) !== undefined
            ? { limit: count(rawResult.limit, 30) }
            : {}),
          ...(count(rawResult.offset, 10000) !== undefined
            ? { offset: count(rawResult.offset, 10000) }
            : {}),
          nextOffset:
            rawResult.nextOffset === null
              ? null
              : (count(rawResult.nextOffset, 10000) ?? null),
          hasMore: rawResult.hasMore === true,
          truncated: rawResult.truncated === true,
          ...(typeof rawResult.coverage === "string"
            ? { coverage: boundedText(rawResult.coverage, 500) }
            : {}),
        }
      : undefined;
  let referenceTextBudget = 24000;
  let referenceAttachmentBudget = 12;
  const referencedRecords = Array.isArray(context.referencedRecords)
    ? context.referencedRecords
        .slice(0, 4)
        .filter(
          (r: any) =>
            r &&
            ["task", "memo"].includes(r.kind) &&
            typeof r.id === "string" &&
            r.id.length > 0 &&
            r.id.length <= 200,
        )
        .map((r: any) => {
          const source =
            typeof r.text === "string"
              ? r.text
              : typeof r.body === "string"
                ? r.body
                : "";
          const text = source.slice(0, Math.min(12000, referenceTextBudget));
          referenceTextBudget -= text.length;
          const allAttachments = attachmentMetadata(r.attachments);
          const attachments = allAttachments.slice(
            0,
            referenceAttachmentBudget,
          );
          referenceAttachmentBudget -= attachments.length;
          return {
            kind: r.kind,
            id: r.id,
            title: boundedText(r.title, 200),
            text,
            attachments,
            truncated:
              r.truncated === true ||
              text.length < source.length ||
              (Array.isArray(r.attachments) &&
                attachments.length < r.attachments.length),
            ...(typeof r.created_at === "string"
              ? { created_at: boundedText(r.created_at, 50) }
              : {}),
            ...(Number.isSafeInteger(r.expected_version) &&
            r.expected_version > 0
              ? { expected_version: r.expected_version }
              : {}),
          };
        })
    : undefined;
  return {
    conversation: history,
    permissionMode: context.permissionMode === "auto" ? "auto" : "confirm",
    ...(phase ? { contextPhase: phase } : {}),
    ...(Array.isArray(context.recentReferences)
      ? {
          recentReferences: context.recentReferences
            .slice(-4)
            .filter(
              (r: any) =>
                r &&
                ["task", "memo"].includes(r.kind) &&
                typeof r.id === "string" &&
                r.id.length > 0 &&
                r.id.length <= 200,
            )
            .map((r: any) => ({
              kind: r.kind,
              id: r.id,
              ...(typeof r.title === "string"
                ? { title: boundedText(r.title, 200) }
                : {}),
            })),
        }
      : {}),
    ...(readBudget ? { contextReadBudget: readBudget } : {}),
    ...(queryResult ? { queryResult } : {}),
    ...(phase !== "plan" && referencedRecords ? { referencedRecords } : {}),
    ...(Array.isArray(context.inputAttachments)
      ? { inputAttachments: attachmentMetadata(context.inputAttachments) }
      : {}),
    ...(phase !== "plan" && Array.isArray(context.taskAttachments)
      ? {
          taskAttachments: context.taskAttachments
            .slice(0, 100)
            .map((t: any) => ({
              taskId: boundedText(t.taskId, 200),
              attachments: attachmentMetadata(t.attachments),
            })),
        }
      : {}),
    ...(phase !== "plan" && inventory ? { memoInventory: inventory } : {}),
    ...(phase !== "plan" && memoSearchResults ? { memoSearchResults } : {}),
    ...(phase !== "plan" && boundedCapture ? { capture: boundedCapture } : {}),
    ...(continuation ? { continuation } : {}),
    ...(typeof context.now === "string"
      ? { now: context.now.slice(0, 50) }
      : {}),
    ...(phase !== "plan" && context.readOnlyRecurrences
      ? { readOnlyRecurrences: context.readOnlyRecurrences }
      : {}),
    ...(phase !== "plan" && context.inventory
      ? { inventory: context.inventory }
      : {}),
    ...(phase !== "plan" && context.readOnlySchedule
      ? { readOnlySchedule: context.readOnlySchedule }
      : {}),
  };
}
