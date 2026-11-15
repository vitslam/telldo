import type { AIProgress, AIActivity } from "../shared/ai-progress";

/** Retains each round's public reply; connection plumbing stays out of the transcript. */
export class ModelRoundProgress {
  private text = "";
  constructor(
    private round: number,
    private chinese: boolean,
    private emit: (event: Exclude<AIProgress, string>) => void,
  ) {}
  forward = (event: AIProgress) => {
    if (typeof event === "string") return;
    if (event.type === "response") {
      this.text = event.text;
      this.reply("running");
      this.emit(event);
    } else if (event.phase !== "connection") {
      this.emit({
        ...event,
        id: `model-${this.round}-${event.id}`,
        ...(event.phase === "response" && this.text ? { text: this.text } : {}),
      });
    }
  };
  complete(summary: string) {
    this.text = summary;
    this.reply("completed");
  }
  private reply(status: AIActivity["status"]) {
    this.emit({
      type: "activity",
      id: `model-${this.round}-response`,
      phase: "response",
      status,
      label: this.chinese ? "生成回复" : "Response",
      text: this.text,
    });
  }
}
