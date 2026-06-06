// loop.resolve — client→server RPC that accepts/rejects a pending proposal.
// Engine.dispatch is paused on the matching log_entry; this method feeds
// the decision back in. Returns once the resolution is applied.
// SPEC.md §13.5 (loop.resolve) + §0.5 (proposal lifecycle).

import type MethodRegistry from "../MethodRegistry.ts";

interface Params {
    logEntryId: number;
    decision: "accept" | "reject" | "cancel";
    body?: string;
    outcome?: string;
}

export default class LoopResolveMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("loop.resolve", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("loop.resolve requires an attached session");
                const p = params as Params;
                if (typeof p.logEntryId !== "number" || p.logEntryId <= 0) {
                    throw new Error("loop.resolve requires positive integer params.logEntryId");
                }
                if (p.decision !== "accept" && p.decision !== "reject" && p.decision !== "cancel") {
                    throw new Error("loop.resolve params.decision must be 'accept' | 'reject' | 'cancel'");
                }
                const resolution: { decision: typeof p.decision; body?: string; outcome?: string } = { decision: p.decision };
                if (typeof p.body === "string") resolution.body = p.body;
                if (typeof p.outcome === "string") resolution.outcome = p.outcome;
                // Engine.resolveProposal throws if the id has no pending waiter
                // (duplicate resolution, already-resolved entry, unknown id).
                // Surface that as a 404-shaped error to the client.
                try {
                    ctx.engine.resolveProposal(p.logEntryId, resolution);
                } catch (err) {
                    return {
                        status: 404,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
                return { status: 200 };
            },
            description: "Resolve a pending proposal (status=202 log entry). Accepts decision: accept|reject|cancel; optional body override and outcome string. Engine.dispatch unpauses on resolution.",
            params: {
                logEntryId: "number — the log_entries.id with state='proposed' to resolve",
                decision: "string — 'accept' | 'reject' | 'cancel'",
                body: "string (optional) — body override for the resolved log entry",
                outcome: "string (optional) — outcome string (e.g. 'policy_veto', 'timeout'); wins over the decision default",
            },
        });
    }
}
