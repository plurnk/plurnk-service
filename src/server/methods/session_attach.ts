import type MethodRegistry from "../MethodRegistry.ts";
import { attachToSession } from "../envelope.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("session.attach", {
        handler: async (params, ctx) => {
            if (ctx.session !== null) {
                throw new Error("connection already has a session attached");
            }
            const p = (params ?? {}) as { id: number; runId?: number; runName?: string };
            if (typeof p.id !== "number") {
                throw new Error("session.attach requires params.id: number");
            }
            if (p.runId !== undefined && typeof p.runId !== "number") {
                throw new Error("session.attach: runId must be a number");
            }
            if (p.runName !== undefined && (typeof p.runName !== "string" || p.runName.length === 0)) {
                throw new Error("session.attach: runName must be a non-empty string");
            }
            const envelope = await attachToSession(ctx.db, p.id, { runId: p.runId, runName: p.runName });
            ctx.attachSession(envelope);
            return {
                id: envelope.sessionId,
                name: envelope.sessionName,
                runId: envelope.runId,
                runName: envelope.runName,
            };
        },
        description: "Attach this connection to an existing session. Optionally resume an existing run by id or name; otherwise creates a fresh run.",
        params: {
            id: "number — session id to attach to",
            runId: "number? — resume the run with this id (must belong to the session)",
            runName: "string? — resume the run with this name within the session; create if absent",
        },
    });
};
