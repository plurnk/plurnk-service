import type MethodRegistry from "../MethodRegistry.ts";
import { listSessions } from "../envelope.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("session.list", {
        handler: async (_params, ctx) => ({ sessions: await listSessions(ctx.db) }),
        description: "List all sessions, most recent first.",
    });
};
