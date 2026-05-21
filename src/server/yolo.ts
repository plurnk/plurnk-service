// YOLO listener — in-tree subscriber to Engine.onProposalPending that
// auto-accepts proposals when the loop has flags.yolo === true. No client
// roundtrip; no human approval; no RPC involvement. Mirrors rummy SPEC
// #yolo_mode but server-side flag-only (no in-process sh/env spawning yet —
// that's exec-stream phase F).
//
// Listener fires BEFORE Engine.#awaitResolution awaits the waiter, so a
// synchronous resolveProposal here is delivered to the awaiting dispatch
// without yielding. The loop/proposal broadcast still goes out (listeners
// fan out independently) — clients in YOLO runs may see a brief
// proposed-then-resolved blink in their UI; that's expected and harmless.

import type Engine from "../core/Engine.ts";
import type { ProposalPendingEvent } from "../core/Engine.ts";
import type { Db, PrepMethod } from "../core/Db.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { LoopFlags } from "../core/scheme-types.ts";

// Reads the loop's stored flags from `loops.flags` (json column added in
// migration 014). Merges over the DEFAULT_LOOP_FLAGS so unknown / missing
// fields fall back cleanly.
const loadLoopFlags = async (db: Db, loopId: number): Promise<LoopFlags> => {
    const row = await (db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: loopId });
    if (row === undefined) return DEFAULT_LOOP_FLAGS;
    try {
        const parsed = JSON.parse(row.flags) as Partial<LoopFlags>;
        return { ...DEFAULT_LOOP_FLAGS, ...parsed };
    } catch {
        return DEFAULT_LOOP_FLAGS;
    }
};

export const attachYolo = (engine: Engine, db: Db): void => {
    engine.onProposalPending((event: ProposalPendingEvent) => {
        // The listener is sync-shaped; loadLoopFlags is async. Fire and
        // forget — if the flags lookup completes before the dispatch's
        // await is hit (typically the case for fast SQL queries), the
        // resolveProposal resolves the waiter immediately. Otherwise the
        // dispatch waits normally; resolution arrives slightly later.
        void (async () => {
            try {
                const flags = await loadLoopFlags(db, event.loopId);
                if (!flags.yolo) return;
                engine.resolveProposal(event.logEntryId, { decision: "accept" });
            } catch {
                // Errors here don't abort dispatch — the proposal stays
                // pending and falls through to the RPC / timeout path.
            }
        })();
    });
};
