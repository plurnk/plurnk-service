import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionRunsMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.runs", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as { id?: number };
                const sessionId = p.id ?? ctx.session?.sessionId;
                if (typeof sessionId !== "number") {
                    throw new Error("session.runs requires params.id: number (or an attached session)");
                }
                return { runs: await Envelope.listRunsForSession(ctx.db, sessionId) };
            },
            description: "List runs in a session, most recent first.",
            params: {
                id: "number? — session id; defaults to the attached session",
            },
        });
    }
}
