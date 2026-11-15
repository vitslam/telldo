import type { Proposal, Settings } from "../shared/types";

/** Applies only validated Telldo proposals, without changing the Codex sandbox. */
export class PermissionSession {
  readonly appliedProposalIds: string[] = [];
  constructor(
    readonly mode: Settings["permissionMode"],
    private readonly isCancelled: () => boolean,
    readonly maxSteps = 8,
  ) {}
  apply(
    proposal: Proposal,
    apply: () => Proposal,
  ): {
    kind: "pending" | "limit" | "duplicate" | "applied";
    proposal: Proposal;
  } {
    if (this.isCancelled()) throw Error("已停止 / Cancelled");
    if (this.mode !== "auto") return { kind: "pending", proposal };
    if (proposal.status === "applied") {
      if (!this.appliedProposalIds.includes(proposal.id))
        this.appliedProposalIds.push(proposal.id);
      return { kind: "duplicate", proposal };
    }
    if (this.appliedProposalIds.length >= this.maxSteps)
      return { kind: "limit", proposal };
    const applied = apply();
    this.appliedProposalIds.push(applied.id);
    return { kind: "applied", proposal: applied };
  }
}
