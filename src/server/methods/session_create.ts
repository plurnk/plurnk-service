import { isAbsolute } from "node:path";
import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import Envelope from "../envelope.ts";
import GitMembership from "../../core/git-membership.ts";

// #200 — membership-overlay effects, mirroring session.constrain (pick admits a
// file git misses / the sole source when headless; hide drops a tracked match;
// view admits a member read-only).
const CONSTRAINT_EFFECTS: ReadonlySet<string> = new Set(["pick", "hide", "view"]);

export default class SessionCreateMethod {
    static register(registry: MethodRegistry): void {
        // session.create makes a session, attaches this connection, and returns the auto-created
        // run's identity (runId/runName) so the client skips the pending-dance. §methods-session-create
        registry.registerMethod("session.create", {
            handler: async (params, ctx) => {
                const p = params as { name?: string; projectRoot?: string | null; persona?: string | null; constraints?: unknown };
                const projectRoot = p.projectRoot ?? null;
                if (projectRoot !== null) {
                    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
                        throw new Error("session.create: projectRoot must be a non-empty string or null");
                    }
                    if (!isAbsolute(projectRoot)) {
                        throw new Error("session.create: projectRoot must be an absolute path");
                    }
                }
                const persona = p.persona ?? null;
                if (persona !== null && typeof persona !== "string") {
                    throw new Error("session.create: persona must be a string or null");
                }
                // #200 — seed the membership overlay atomically with the session so
                // turn-1's manifest already reflects it (no follow-up session.constrain
                // RPC race). Same effects/semantics as session.constrain.
                const constraints = SessionCreateMethod.#parseConstraints(p.constraints);
                const envelope = await Envelope.createClientEnvelope(ctx.db, { name: p.name, projectRoot, persona });
                if (constraints.length > 0) {
                    for (const { effect, glob } of constraints) {
                        await (ctx.db.crud_insert_session_constraint as PrepMethod).run({ session_id: envelope.sessionId, effect, glob });
                    }
                    await GitMembership.resolveGitMembership(ctx.db, envelope.sessionId, undefined);
                }
                ctx.attachSession(envelope);
                ctx.notify("all", "session/created", {
                    id: envelope.sessionId,
                    name: envelope.sessionName,
                    projectRoot: envelope.projectRoot,
                    persona: envelope.sessionPersona,
                });
                return {
                    id: envelope.sessionId, name: envelope.sessionName,
                    runId: envelope.runId, runName: envelope.runName,
                    projectRoot: envelope.projectRoot, persona: envelope.sessionPersona,
                };
            },
            description: "Create a new session and attach this connection to it. Optionally pin the session to a workspace via projectRoot, and/or set a session-level persona (text/markdown injected into packet.system.persona). Per-run and per-loop overrides may further refine the persona.",
            params: {
                name: "string? — session name (auto-generated if omitted)",
                projectRoot: "string? — absolute path to the client's workspace; null/omitted = headless mode (no disk side-effects on file ops)",
                persona: "string? — session-level persona (text/markdown); cascades as: loops.persona > runs.persona > sessions.persona > PLURNK_PERSONA file",
                constraints: "array? — [{effect, glob}] membership overlay seeded atomically at creation so turn-1's manifest is right with no follow-up RPC. effect: pick (admit a file git misses / the sole source when headless) | hide (drop a tracked match) | view (read-only). glob: node:path glob vs workspace-relative paths.",
            },
        });

        registry.registerNotification("session/created", {
            description: "A new session has been created. Broadcast to all connected clients.",
            params: {
                id: "number — session id",
                name: "string — session name",
                projectRoot: "string|null — workspace pointer for the session (null = headless)",
                persona: "string|null — session-level persona override (null = no override at this level)",
            },
        });
    }

    static #parseConstraints(raw: unknown): Array<{ effect: string; glob: string }> {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new Error("session.create: constraints must be an array");
        return raw.map((c, i) => {
            const e = c as { effect?: unknown; glob?: unknown };
            if (typeof e.effect !== "string" || !CONSTRAINT_EFFECTS.has(e.effect)) {
                throw new Error(`session.create: constraints[${i}].effect must be one of pick | hide | view`);
            }
            if (typeof e.glob !== "string" || e.glob.length === 0) {
                throw new Error(`session.create: constraints[${i}].glob must be a non-empty string`);
            }
            return { effect: e.effect, glob: e.glob };
        });
    }
}
