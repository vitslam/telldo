import type { AIActivity, AIProgress } from "../shared/ai-progress";

export type ProgressEnvelope = Exclude<AIProgress, string> & {
  requestId?: string;
  roundId?: string;
};
export interface ProgressBatch {
  requestId: string;
  activities: AIActivity[];
  response?: { text: string; roundId?: string };
}

/** Coalesces real upstream snapshots into a single render per browser frame. */
export class ProgressBatcher {
  private requestId: string | null = null;
  private frame: number | null = null;
  private activities = new Map<string, AIActivity>();
  private response?: ProgressBatch["response"];
  private roundId?: string;
  private roundIndex = 0;
  private seenRounds = new Set<string>();

  constructor(
    private commit: (batch: ProgressBatch) => void,
    private schedule: (callback: () => void) => number = (callback) =>
      requestAnimationFrame(callback),
    private cancel: (frame: number) => void = (frame) =>
      cancelAnimationFrame(frame),
  ) {}

  begin(requestId: string) {
    this.dispose();
    this.requestId = requestId;
  }

  push(event: ProgressEnvelope) {
    if (!this.requestId || event.requestId !== this.requestId) return;
    if (event.type === "response") {
      if (event.roundId) {
        const index = Number(event.roundId.match(/^model-(\d+)$/)?.[1] || 0);
        if (index && index < this.roundIndex) return;
        if (event.roundId !== this.roundId) {
          if (this.seenRounds.has(event.roundId)) return;
          this.seenRounds.add(event.roundId);
          this.roundId = event.roundId;
          this.roundIndex = index;
        }
      } else if (this.roundId) {
        // Once tagged streaming starts, stale legacy previews cannot replace it.
        return;
      }
      this.response = { text: event.text, roundId: event.roundId };
    } else if (event.type === "activity") {
      this.activities.set(event.id, {
        ...this.activities.get(event.id),
        ...event,
      });
    } else return;
    if (this.frame === null)
      this.frame = this.schedule(() => {
        this.frame = null;
        this.flush();
      });
  }

  flush() {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    if (!this.requestId || (!this.response && !this.activities.size)) return;
    const batch: ProgressBatch = {
      requestId: this.requestId,
      activities: [...this.activities.values()],
      ...(this.response ? { response: this.response } : {}),
    };
    this.activities.clear();
    this.response = undefined;
    this.commit(batch);
  }

  finish(requestId: string) {
    if (requestId !== this.requestId) return;
    // Completion and cancellation must not wait for a throttled/background frame.
    this.flush();
    this.dispose();
  }

  dispose() {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    this.requestId = null;
    this.activities.clear();
    this.response = undefined;
    this.roundId = undefined;
    this.roundIndex = 0;
    this.seenRounds.clear();
  }
}
