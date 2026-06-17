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
                const p = params as { name?: string; projectRoot?: string | null; constraints?: unknown; settings?: unknown };
                const projectRoot = p.projectRoot ?? null;
                if (projectRoot !== null) {
                    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
                        throw new Error("session.create: projectRoot must be a non-empty string or null");
                    }
                    if (!isAbsolute(projectRoot)) {
                        throw new Error("session.create: projectRoot must be an absolute path");
                    }
                }
                // #200 — seed the membership overlay atomically with the session so
                // turn-1's manifest already reflects it (no follow-up session.constrain
                // RPC race). Same effects/semantics as session.constrain.
                const constraints = SessionCreateMethod.#parseConstraints(p.constraints);
                // #231 — client-chosen open-context, persisted on the session and read at
                // turn-0 with precedence over env (manifestItems replaces, mdDocs unions).
                const settings = SessionCreateMethod.#parseSettings(p.settings);
                const envelope = await Envelope.createClientEnvelope(ctx.db, { name: p.name, projectRoot, settings });
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
                });
                return {
                    id: envelope.sessionId, name: envelope.sessionName,
                    runId: envelope.runId, runName: envelope.runName,
                    projectRoot: envelope.projectRoot,
                };
            },
            description: "Create a new session and attach this connection to it. Optionally pin the session to a workspace via projectRoot.",
            params: {
                name: "string? — session name (auto-generated if omitted)",
                projectRoot: "string? — absolute path to the client's workspace; null/omitted = headless mode (no disk side-effects on file ops)",
                constraints: "array? — [{effect, glob}] membership overlay seeded atomically at creation so turn-1's manifest is right with no follow-up RPC. effect: pick (admit a file git misses / the sole source when headless) | hide (drop a tracked match) | view (read-only). glob: node:path glob vs workspace-relative paths.",
                settings: "object? — client-chosen open-context, persisted per session, read at turn-0 over env. { manifestItems?: number (-1 full | 0 off | N first-N; replaces PLURNK_MANIFEST_ITEMS), mdDocs?: [{alias, content}] (unioned with server PLURNK_MD_* docs; client wins on alias collision) }",
            },
        });

        registry.registerNotification("session/created", {
            description: "A new session has been created. Broadcast to all connected clients.",
            params: {
                id: "number — session id",
                name: "string — session name",
                projectRoot: "string|null — workspace pointer for the session (null = headless)",
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

    // #231 — validate + serialize the client open-context bag. manifestItems is a scalar
    // (replace); mdDocs is [{alias, content}] (union'd with env at turn-0). Alias is a clean
    // entry-name fragment ([\w.-]) since it becomes plurnk:///<alias>.md. Returns JSON ('{}'
    // when absent). Operator-arcane knobs stay env-only by omission — this is the client surface.
    static #parseSettings(raw: unknown): string {
        if (raw === undefined || raw === null) return "{}";
        if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("session.create: settings must be an object");
        const r = raw as { manifestItems?: unknown; mdDocs?: unknown };
        const out: { manifestItems?: number; mdDocs?: Array<{ alias: string; content: string }> } = {};
        if (r.manifestItems !== undefined) {
            if (typeof r.manifestItems !== "number" || !Number.isInteger(r.manifestItems)) {
                throw new Error("session.create: settings.manifestItems must be an integer (-1 full | 0 off | N first-N)");
            }
            out.manifestItems = r.manifestItems;
        }
        if (r.mdDocs !== undefined) {
            if (!Array.isArray(r.mdDocs)) throw new Error("session.create: settings.mdDocs must be an array");
            out.mdDocs = r.mdDocs.map((d, i) => {
                const e = d as { alias?: unknown; content?: unknown };
                if (typeof e.alias !== "string" || e.alias.length === 0 || /[^\w.-]/.test(e.alias)) {
                    throw new Error(`session.create: settings.mdDocs[${i}].alias must be a non-empty [\\w.-] string`);
                }
                if (typeof e.content !== "string") throw new Error(`session.create: settings.mdDocs[${i}].content must be a string`);
                return { alias: e.alias, content: e.content };
            });
        }
        return JSON.stringify(out);
    }
}
