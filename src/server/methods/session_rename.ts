import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import Envelope from "../envelope.ts";

export default class SessionRenameMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.rename", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("session.rename requires an attached session");
                const p = params as { name?: string };
                if (typeof p.name !== "string" || p.name.length === 0) throw new Error("session.rename: name must be a non-empty string");
                // sessions.name is UNIQUE — refuse a name another session already holds. Renaming
                // to the session's own name is a no-op and allowed. The UNIQUE index is the real
                // guard; this pre-check is for a clean error in the common case.
                const taken = await (ctx.db.envelope_get_session_by_name as PrepMethod).get<{ id: number }>({ name: p.name });
                if (taken !== undefined && taken.id !== ctx.session.sessionId) {
                    throw new Error(`session.rename: a session named "${p.name}" already exists — pick another`);
                }
                const name = await Envelope.updateSessionName(ctx.db, ctx.session.sessionId, p.name);
                // Refresh the attached envelope (same object ref as ClientConnection.#session)
                // so subsequent handler invocations on this connection observe the new name.
                ctx.session.sessionName = name;
                return { id: ctx.session.sessionId, name };
            },
            description: "Rename the currently-attached session — its name is a mutable handle on the world (unlike a run, whose name is frozen at instantiation, §machine-processes). Mutates sessions.name only; runs, log, and membership are untouched. A name another session already holds is rejected (sessions.name is unique).",
            params: {
                name: "string — the new session name (non-empty; must not collide with another session)",
            },
            requiresInit: true,
        });
    }
}
