import type { ChatMessage } from "./conversation";
import type { AIActivity } from "./ai-progress";

export interface ConversationAttachment {
  id: string;
  name: string;
  bytes?: number;
  kind: "image" | "file";
  previewUrl?: string;
}
/** IDs bind sources; titles are display text only. */
export interface ContentReference {
  kind: "memo" | "task";
  id: string;
  title: string;
  attachmentCount?: number;
  asTask?: boolean;
}
export interface ConversationMessage extends ChatMessage {
  attachments?: ConversationAttachment[];
  references?: ContentReference[];
  turnId?: string;
  notice?: string;
  activities?: AIActivity[];
  state?: "working" | "completed" | "cancelled" | "error";
  startedAt?: number;
  finishedAt?: number;
}
export interface ChatSessionSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
}
export interface ChatSession extends ChatSessionSummary {
  messages: ConversationMessage[];
}
export interface ChatHistoryPage {
  items: ChatSessionSummary[];
  total: number;
  hasMore: boolean;
}
