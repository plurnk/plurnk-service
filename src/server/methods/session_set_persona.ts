import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionSetPersonaMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.set_persona", {
            handler: async (params, ctx) => {
                if (ctx.session === null) {
                    throw new Error("session.set_persona requires an attached session");
                }
                const p = (params ?? {}) as { persona?: string | null };
                const persona = p.persona ?? null;
                if (persona !== null && typeof persona !== "string") {
                    throw new Error("session.set_persona: persona must be a string or null");
                }
                const updated = await Envelope.updateSessionPersona(ctx.db, ctx.session.sessionId, persona);
                // Mutate the attached envelope so subsequent handler invocations
                // on this connection observe the new value. ctx.session is the
                // same object reference held in ClientConnection.#session.
                ctx.session.sessionPersona = updated;
                return { id: ctx.session.sessionId, persona: updated };
            },
            description: "Update the session-level persona (text/markdown injected into packet.system.persona when no per-run or per-loop override exists). Pass null to clear the override and fall through to PLURNK_PERSONA file.",
            params: {
                persona: "string|null — session-level persona content; null clears the override",
            },
            requiresInit: true,
        });
    }
}
