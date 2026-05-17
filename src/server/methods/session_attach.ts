import type MethodRegistry from "../MethodRegistry.ts";
import { attachToSession } from "../envelope.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("session.attach", {
        handler: async (params, ctx) => {
            if (ctx.session !== null) {
                throw new Error("connection already has a session attached");
            }
            const p = (params ?? {}) as { id: number };
            if (typeof p.id !== "number") {
                throw new Error("session.attach requires params.id: number");
            }
            const envelope = attachToSession(ctx.db, p.id);
            ctx.attachSession(envelope);
            return { id: envelope.sessionId, name: envelope.sessionName };
        },
        description: "Attach this connection to an existing session. Creates a new run for this connection.",
        params: {
            id: "number — session id to attach to",
        },
    });
};
