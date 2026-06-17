import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

// #238 — session.prompts: a session's prior user prompts, newest-first, for a client's
// up/down readline history. The daemon is the source of truth (the client's in-memory
// history dies with its process); this hands it over directly instead of forcing the
// log-archaeology path (session.runs → log.read → filter prompt entries → dig tx.body).
export default class SessionPromptsMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.prompts", {
            handler: async (params, ctx) => {
                const p = params as { id?: number; limit?: number };
                const sessionId = p.id ?? ctx.session?.sessionId;
                if (typeof sessionId !== "number") {
                    throw new Error("session.prompts requires params.id: number (or an attached session)");
                }
                const limit = p.limit ?? 100;
                if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
                    throw new Error("session.prompts: limit must be a positive integer");
                }
                return { prompts: await Envelope.listPromptsForSession(ctx.db, sessionId, limit) };
            },
            description: "List a session's prior user prompts, newest-first (for client up/down history); defaults to the attached session.",
            params: {
                id: "number? — session id; defaults to the attached session",
                limit: "number? — max prompts returned, newest-first (default 100)",
            },
        });
    }
}
