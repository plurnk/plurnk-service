import type MethodRegistry from "../MethodRegistry.ts";
import { createClientEnvelope } from "../envelope.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("session.create", {
        handler: async (params, ctx) => {
            if (ctx.session !== null) {
                throw new Error("connection already has a session attached");
            }
            const p = (params ?? {}) as { name?: string };
            const envelope = createClientEnvelope(ctx.db, { name: p.name });
            ctx.attachSession(envelope);
            ctx.notify("all", "session/created", {
                id: envelope.sessionId,
                name: envelope.sessionName,
            });
            return { id: envelope.sessionId, name: envelope.sessionName };
        },
        description: "Create a new session and attach this connection to it.",
        params: {
            name: "string? — session name (auto-generated if omitted)",
        },
    });

    registry.registerNotification("session/created", {
        description: "A new session has been created. Broadcast to all connected clients.",
        params: {
            id: "number — session id",
            name: "string — session name",
        },
    });
};
