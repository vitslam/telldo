import type { AIActivity } from "./ai-progress";
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposalId?: string;
  error?: boolean;
}
export interface ChatReply {
  activities?: AIActivity[];
  kind: "answer" | "proposal";
  message: string;
  proposalId?: string;
}
export function conversationContext(context: Record<string, unknown>) {
  const history = Array.isArray(context.conversation)
    ? context.conversation
        .slice(-12)
        .filter(
          (x: any) =>
            x &&
            ["user", "assistant"].includes(x.role) &&
            typeof x.content === "string",
        )
        .map((x: any) => ({ role: x.role, content: x.content.slice(0, 2000) }))
    : [];
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
  return {
    conversation: history,
    ...(continuation ? { continuation } : {}),
    ...(typeof context.now === "string"
      ? { now: context.now.slice(0, 50) }
      : {}),
    ...(context.readOnlyRecurrences
      ? { readOnlyRecurrences: context.readOnlyRecurrences }
      : {}),
    inventory: context.inventory,
    readOnlySchedule: context.readOnlySchedule,
  };
}
