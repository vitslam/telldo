import { parseAIProgress, type AIProgress } from "../shared/ai-progress";
/** Decode bounded delta frames, while accepting cumulative replies from older helpers. */
export class SshProgressDecoder {
  private text = "";
  decode(value: unknown): Exclude<AIProgress, string> | null {
    if (!value || typeof value !== "object") return null;
    const frame = value as Record<string, unknown>;
    if (frame.type === "response" && frame.delta !== undefined) {
      if (
        typeof frame.delta !== "string" ||
        frame.text !== undefined ||
        this.text.length + frame.delta.length > 2000
      )
        return null;
      value = { type: "response", text: this.text + frame.delta };
    }
    const progress = parseAIProgress(value);
    if (progress?.type === "response") this.text = progress.text;
    return progress;
  }
}
