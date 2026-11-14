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
  return {
    conversation: history,
    inventory: context.inventory,
    readOnlySchedule: context.readOnlySchedule,
  };
}
