// Server-side noProposals listener — the exact inverse of yolo.ts. When a
// loop's persisted flags.noProposals === true, proposals auto-REJECT
// in-process, mirroring server-YOLO's auto-ACCEPT. No client roundtrip; no
// human review.
//
// Invisibility is the whole point. The model sees only the ordinary
// post-resolution result — identical to a human declining the proposal or a
// client's no_tty_review reject. The `outcome` reason is forensics-only,
// never in the rx (see ProposalResolution), so a reject under noProposals is
// indistinguishable, to the model, from any other reject. How a proposal is
// handled — manual review, client YOLO, server YOLO, noProposals — leaves no
// fingerprint in the model's experience.
//
// Use case: a client with no review channel (no TTY — piped, scripted,
// redirected) sets noProposals so side-effecting ops fail closed WITHOUT a
// client roundtrip per proposal. The client, which set the flag, owns any
// end-user "edits were blocked, no review channel" messaging; the model is
// mode-blind.
//
// yolo wins if both are (nonsensically) set — the explicit auto-accept
// opt-in takes precedence over the auto-reject.

import type Engine from "../core/Engine.ts";
import type { ProposalPendingEvent } from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";

export default class NoProposals {
    static attachNoProposals(engine: Engine, _db: Db): void {
        engine.onProposalPending((event: ProposalPendingEvent) => {
            if (event.flags.yolo || !event.flags.noProposals) return;
            try {
                engine.resolveProposal(event.logEntryId, { decision: "reject", outcome: "no_review_channel" });
            } catch {
                // Errors here don't abort dispatch — the proposal stays
                // pending and falls through to the RPC / timeout path.
            }
        });
    }
}
