// loop.cancel — abort the run's active drain. Fires the drain's
// AbortController, which cascades to engine.runLoop's loop signal, which
// in turn aborts in-flight scheme operations (exec spawns, future
// SSE/WS). Queued loops in the run remain enqueued for a subsequent
// loop.run to pick up.
//
// Pairs with loop.run for "redirect" UX: cancel the runaway loop, then
// send a fresh prompt. Without this, the user would have to wait for
// the loop to hit max_turns / strike out.

import type MethodRegistry from "../MethodRegistry.ts";

interface Params {
    reason?: string;
}

export default class LoopCancelMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("loop.cancel", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("loop.cancel requires an attached session");
                const p = params as Params;
                const reason = (typeof p.reason === "string" && p.reason.length > 0) ? p.reason : "user_cancelled";
                const cancelled = ctx.daemon.cancelDrain(ctx.session.runId, reason);
                return { cancelled, runId: ctx.session.runId, reason };
            },
            description: "Abort the run's active drain. Returns {cancelled: true} if a drain was running; {cancelled: false} if the run was already idle. Cancelled loops close at status 499. Queued (but not yet claimed) loops remain enqueued; subsequent loop.run resumes the queue.",
            params: {
                reason: "string? — optional human-readable cancellation reason; defaults to 'user_cancelled'",
            },
            requiresInit: true,
        });
    }
}
