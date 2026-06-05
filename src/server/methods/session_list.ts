import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionListMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.list", {
            handler: async (_params, ctx) => ({ sessions: await Envelope.listSessions(ctx.db) }),
            description: "List all sessions, most recent first.",
        });
    }
}
