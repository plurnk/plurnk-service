import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionAttachMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.attach", {
            handler: async (params, ctx) => {
                if (ctx.session !== null) {
                    throw new Error("connection already has a session attached");
                }
                const p = params as { id: number; runId?: number; runName?: string; persona?: string | null };
                if (typeof p.id !== "number") {
                    throw new Error("session.attach requires params.id: number");
                }
                if (p.runId !== undefined && typeof p.runId !== "number") {
                    throw new Error("session.attach: runId must be a number");
                }
                if (p.runName !== undefined && (typeof p.runName !== "string" || p.runName.length === 0)) {
                    throw new Error("session.attach: runName must be a non-empty string");
                }
                const persona = p.persona ?? null;
                if (persona !== null && typeof persona !== "string") {
                    throw new Error("session.attach: persona must be a string or null");
                }
                const envelope = await Envelope.attachToSession(ctx.db, p.id, { runId: p.runId, runName: p.runName, persona });
                ctx.attachSession(envelope);
                return {
                    id: envelope.sessionId,
                    name: envelope.sessionName,
                    sessionPersona: envelope.sessionPersona,
                    runId: envelope.runId,
                    runName: envelope.runName,
                    runPersona: envelope.runPersona,
                };
            },
            description: "Attach this connection to an existing session. Optionally resume an existing run by id or name; otherwise creates a fresh run. The persona param sets run-level persona ONLY when a new run is created (reusing an existing run preserves its stored persona; use session.set_persona for session-level changes).",
            params: {
                id: "number — session id to attach to",
                runId: "number? — resume the run with this id (must belong to the session)",
                runName: "string? — resume the run with this name within the session; create if absent",
                persona: "string? — run-level persona (text/markdown); applied to a NEWLY created run only",
            },
        });
    }
}
