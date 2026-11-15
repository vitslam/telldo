import type { ContextQuery } from "./context-query";
import type { MemoAttachment } from "./memo";
export type Priority = "none" | "low" | "medium" | "high";
export type View = "today" | "planned" | "anytime" | string;
export interface List {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Tag {
  id: string;
  name: string;
}
export interface Task {
  attachments?: MemoAttachment[];
  id: string;
  list_id: string;
  parent_id: string | null;
  title: string;
  notes: string;
  status: "todo" | "done";
  priority: Priority;
  due_kind: "none" | "date" | "datetime";
  due_date: string | null;
  due_at: string | null;
  time_zone: string | null;
  planned_date: string | null;
  reminder_at: string | null;
  completed_at: string | null;
  version: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tags: string[];
}
export type TaskPatch = Partial<
  Pick<
    Task,
    | "list_id"
    | "parent_id"
    | "title"
    | "notes"
    | "status"
    | "priority"
    | "due_kind"
    | "due_date"
    | "due_at"
    | "time_zone"
    | "planned_date"
    | "reminder_at"
    | "sort_order"
    | "tags"
  >
>;
export interface Recurrence {
  id: string;
  task_id: string;
  rrule: string;
  dtstart: string;
  tzid: string;
  until: string | null;
  count: number | null;
  exdates: string[];
}
export interface Occurrence {
  series_id: string;
  occurrence_key: string;
  status: "todo" | "done" | "skipped";
  due_date: string;
  due_at: string | null;
  override_date: string | null;
  version?: number;
  override_due_at?: string | null;
  reminder_override?: "inherit" | "explicit";
  override_reminder_at?: string | null;
  completed_at: string | null;
}
export interface TaskProposalAction {
  type:
    | "create"
    | "update"
    | "complete"
    | "uncomplete"
    | "reschedule"
    | "delete"
    | "add_subtask"
    | "set_tags";
  target_id?: string;
  temp_id?: string;
  expected_version?: number;
  patch: TaskPatch;
}
export interface CreateListAction {
  type: "create_list";
  temp_id: string;
  target_id?: never;
  expected_version?: never;
  patch: { name: string; color?: string };
}
export type RecurringTaskPatch = Omit<
  TaskPatch,
  "title" | "list_id" | "due_kind" | "due_date" | "parent_id" | "status"
> & {
  title: string;
  list_id: string;
  due_kind: "date" | "datetime";
  due_date: string;
  parent_id?: null;
  status?: "todo";
  rrule: string;
  dtstart: string;
  tzid: string;
  until?: string | null;
  count?: number | null;
};
export interface CreateRecurringAction {
  type: "create_recurring";
  temp_id: string;
  target_id?: never;
  expected_version?: never;
  patch: RecurringTaskPatch;
}
export interface UpdateRecurringAction {
  type: "update_recurring";
  target_id: string;
  expected_version: number;
  temp_id?: never;
  patch: RecurringTaskPatch;
}
export type ProposalAction =
  | TaskProposalAction
  | CreateListAction
  | CreateRecurringAction
  | UpdateRecurringAction;
export interface ProposalInput {
  version: 1;
  summary: string;
  idempotency_key: string;
  risk: "low" | "high";
  actions: ProposalAction[];
}
/** A capture response never enters the task mutation/confirmation pipeline. */
export interface MemoCapture {
  tempId: string;
  title?: string;
  text: string;
  summary?: string;
  listId?: string;
  attachmentIds?: string[];
}
export interface AIResponse extends ProposalInput {
  /** A host-side bounded read request; never a mutation proposal. */
  query?: ContextQuery;
  memo?: MemoCapture;
  assetAssignments?: { actionIndex: number; attachmentIds: string[] }[];
}
export interface Proposal extends ProposalInput {
  id: string;
  source_text: string;
  model_raw: string;
  status: "pending" | "applied" | "rejected" | "failed" | "undone";
  created_at: string;
}
export interface Settings {
  theme: "mono" | "forest" | "ocean" | "plum";
  appearance: "system" | "light" | "dark";
  language: "system" | "zh" | "en";
  timeZone: string;
  codexPath: string;
  aiTransport: "local" | "ssh";
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshCodexPath: string;
  sshRunnerPath: string;
  sshProxyUrl: string;
  permissionMode: "confirm" | "auto";
  alwaysConfirm: boolean;
  closeToTray: boolean;
}
export interface Capabilities {
  available: boolean;
  version: string;
  path: string;
  loggedIn: boolean;
  reason: string;
  schema: boolean;
  outputFile: boolean;
  json: boolean;
  readOnly: boolean;
  ignoreUserConfig: boolean;
  ignoreRules: boolean;
  ephemeral: boolean;
  skipGitCheck: boolean;
  isolation: string;
}
export interface Snapshot {
  lists: List[];
  tasks: Task[];
  recurrences: Recurrence[];
  occurrences: Occurrence[];
  proposals: Proposal[];
  settings: Settings;
  systemLanguage: string;
  systemTimeZone: string;
  capabilities: Capabilities | null;
}
export interface Bridge {
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  onEvent(
    callback: (event: { type: string; data: unknown }) => void,
  ): () => void;
}
declare global {
  interface Window {
    telldo: Bridge;
  }
}
