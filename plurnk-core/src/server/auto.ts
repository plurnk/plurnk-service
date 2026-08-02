// Loop auto-approval listener — resolves proposals when persisted flags.auto is true.
// No client roundtrip; no human approval; no RPC involvement.
//
// === Loop auto vs client-side YOLO ===
//
// These are distinct features. Both have legitimate use cases. Neither
// replaces the other.
//
//   Loop auto (this file)
//     - Enabled via loops.flags.auto = true. RPC opt-in:
//       loop.run({ prompt, flags: { auto: true } }).
//     - Engine auto-accepts in-process; the client need not be connected.
//     - Use cases: benchmarks (pure model+grammar timing, no RPC roundtrip
//       in the hot loop), CI runs, ad-hoc internal automation, test
//       fixtures. Anywhere "just run and tell me the final state" is the
//       right contract.
//     - Client apps (@plurnk/plurnk CLI / TUI) intentionally do NOT expose
//       this flag — loop auto is automation authority, not review ergonomics.
//
//   Client-side YOLO (@plurnk/plurnk --yolo / PLURNK_YOLO)
//     - Client receives the loop/proposal notification and immediately
//       sends loop.resolve({decision:"accept", outcome:"client_yolo"}).
//     - The wire roundtrip still happens; the daemon stays unaware that
//       no human reviewed.
//     - Use cases: real users who want "stop bothering me" ergonomics
//       across an interactive workspace. Documented by the client.
//
// Listener fires BEFORE ProposalLifecycle.awaitResolution awaits the waiter, so a
// synchronous resolveProposal here is delivered to the awaiting dispatch
// without yielding. The loop/proposal broadcast still goes out (listeners
// fan out independently) — clients observing auto loops may see a brief
// proposed-then-resolved blink in their UI. The carried event.flags.auto
// lets clients suppress review-UI rendering for those entries.

import type Engine from "../core/Engine.ts";
import type { ProposalPendingEvent } from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";

export default class Auto {
    static attach(engine: Engine, _db: Db): void {
        // {§proposal-ownership-loop-auto}
        engine.onProposalPending((event: ProposalPendingEvent) => {
            if (!event.flags.auto) return;
            // A [300] question is NOT automatic (#346): it exists precisely to stop the world
            // for a human — auto-accepting answers nothing. The workspace opted into questions
            // (settings.questions), so the stop is wanted even under auto.
            if (event.op === "SEND" && (event.attrs as { question?: string }).question !== undefined) return;
            try {
                if (event.staleClobberRisk) {
                    // #note10 — the target diverged on disk this turn; the model's EDIT is
                    // based on a stale read. Reject rather than silently clobber the ambient
                    // change. The model sees an ordinary reject (outcome is forensics-only)
                    // and can re-READ the entry + retry against the current content.
                    engine.resolveProposal(event.logEntryId, { decision: "reject", outcome: "stale_read_clobber" });
                    return;
                }
                engine.resolveProposal(event.logEntryId, { decision: "accept" });
            } catch {
                // Errors here don't abort dispatch — the proposal stays
                // pending and falls through to the RPC / timeout path.
            }
        });
    }
}
