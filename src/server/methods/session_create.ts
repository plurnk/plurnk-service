import { isAbsolute } from "node:path";
import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import Envelope from "../envelope.ts";
import GitMembership from "../../core/git-membership.ts";

// #200 — membership-overlay effects, mirroring session.constrain (pick admits a
// file git misses / the sole source when headless; hide drops a tracked match;
// view admits a member read-only; repo declares a git repo folder anywhere).
const CONSTRAINT_EFFECTS: ReadonlySet<string> = new Set(["pick", "hide", "view", "repo"]);

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
                // turn-0 with precedence over env (filesItems replaces, mdDocs unions).
                const settings = SessionCreateMethod.#parseSettings(p.settings);
                const envelope = await Envelope.createClientEnvelope(ctx.db, { name: p.name, projectRoot, settings });
                if (constraints.length > 0) {
                    for (const { effect, glob } of constraints) {
                        await (ctx.db.crud_insert_session_constraint as PrepMethod).run({ session_id: envelope.sessionId, effect, glob });
                    }
                    await GitMembership.resolveGitMembership(ctx.db, envelope.sessionId, undefined);
                }
                ctx.attachSession(envelope);
                // #290 — warm the session's embeddings/deep channels NOW, during the client's startup
                // window, instead of freezing the first loop.run. Fire-and-forget: create returns
                // immediately and embed_progress streams as it runs; turn 1's pump is the backstop.
                void ctx.engine.warmSessionDerivations(envelope.sessionId).catch(() => {});
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
                constraints: "array? — [{effect, glob}] membership overlay seeded atomically at creation so turn-1's manifest is right with no follow-up RPC. effect: pick (admit a file git misses / the sole source when headless) | hide (drop a tracked match) | view (read-only) | repo (declare a git repo folder anywhere — its members join the manifest, addressed relative to the project root: clean under it, `..`-prefixed outside). glob: node:path glob vs workspace-relative paths (a folder for repo).",
                settings: "object? — client-chosen open-context, persisted per session, read at turn-0 over env. { filesItems?: number (-1 full | 0 off | N first-N; replaces PLURNK_SERVICE_FILES_ITEMS), mdDocs?: [{alias, content}] (unioned with server PLURNK_SERVICE_MD_* docs; client wins on alias collision), client?: string (#249 — session-stable frontend id, e.g. 'plurnk.nvim/1.4.0', forwarded to the plurnk provider as Plurnk-Client; dropped by other providers), execs?: { [PLURNK_EXECS_* flag]: string } (#328 — the client's exec-runtime policy layer, subtractive: narrows the boot-registered set per session, never widens; e.g. { PLURNK_EXECS_ONLY: 'search' } or { PLURNK_EXECS_NODE: '0' }. MCP server-config keys rejected), questions?: boolean (§send-300-choices — the client's affirmative request for operator questions ([300]): enabled only if ALSO allowed servicewide (PLURNK_QUESTIONS != 0); enabling injects the questions.md teaching) }",
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
                throw new Error(`session.create: constraints[${i}].effect must be one of pick | hide | view | repo`);
            }
            if (typeof e.glob !== "string" || e.glob.length === 0) {
                throw new Error(`session.create: constraints[${i}].glob must be a non-empty string`);
            }
            return { effect: e.effect, glob: e.glob };
        });
    }

    // #231 — validate + serialize the client open-context bag. filesItems is a scalar
    // (replace); mdDocs is [{alias, content}] (union'd with env at turn-0). Alias is a clean
    // entry-name fragment ([\w.-]) since it becomes plurnk:///<alias>.md. Returns JSON ('{}'
    // when absent). Operator-arcane knobs stay env-only by omission — this is the client surface.
    static #parseSettings(raw: unknown): string {
        if (raw === undefined || raw === null) return "{}";
        if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("session.create: settings must be an object");
        const r = raw as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; mdDocs?: unknown; client?: unknown; execs?: unknown; questions?: unknown };
        const out: { filesItems?: number; maxCommands?: number; git?: boolean; mdDocs?: Array<{ alias: string; content: string }>; client?: string; execs?: Record<string, string>; questions?: boolean } = {};
        if (r.filesItems !== undefined) {
            if (typeof r.filesItems !== "number" || !Number.isInteger(r.filesItems)) {
                throw new Error("session.create: settings.filesItems must be an integer (-1 full | 0 off | N first-N)");
            }
            out.filesItems = r.filesItems;
        }
        // #232 — tighten-only ceilings: a client may narrow, never widen (composed
        // most-restrictive-wins at each read-site). maxCommands min()s the env ceiling;
        // git:false denies git for the session (env AND session).
        if (r.maxCommands !== undefined) {
            if (typeof r.maxCommands !== "number" || !Number.isInteger(r.maxCommands) || r.maxCommands < 0) {
                throw new Error("session.create: settings.maxCommands must be a non-negative integer (a tighten-only ceiling; 0 = plan + conclude only, no actions)");
            }
            out.maxCommands = r.maxCommands;
        }
        if (r.git !== undefined) {
            if (typeof r.git !== "boolean") throw new Error("session.create: settings.git must be a boolean (false denies git for the session)");
            out.git = r.git;
        }
        // §send-300-choices — operator questions: the client AFFIRMATIVELY requests them per
        // session (its own PLURNK_QUESTIONS=1 forwarded); enabled = allowed (service env) AND this.
        if (r.questions !== undefined) {
            if (typeof r.questions !== "boolean") throw new Error("session.create: settings.questions must be a boolean (operator questions — [300] — requested for this session)");
            out.questions = r.questions;
        }
        // #249 — session-stable frontend id (e.g. "plurnk.nvim/1.4.0"), forwarded to the plurnk
        // provider as Plurnk-Client telemetry; ignored by every other provider. Self-identified.
        if (r.client !== undefined) {
            if (typeof r.client !== "string" || r.client.length === 0) {
                throw new Error("session.create: settings.client must be a non-empty string (the frontend id, e.g. 'plurnk.nvim/1.4.0')");
            }
            out.client = r.client;
        }
        // #328 — the client's resolved PLURNK_EXECS_* policy subset, verbatim key→value, fed to execs'
        // Policy as the per-session client layer (subtractive: narrows the boot-registered set, never
        // widens). PLURNK_EXECS_MCP_* (server URLs + _HEADERS tokens) MUST NOT ride the wire — refused
        // here as defense-in-depth even though the client already excludes them (the bare MCP toggle stays).
        if (r.execs !== undefined) {
            if (typeof r.execs !== "object" || r.execs === null || Array.isArray(r.execs)) {
                throw new Error("session.create: settings.execs must be an object of PLURNK_EXECS_* key→value strings");
            }
            const execs: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.execs as Record<string, unknown>)) {
                if (!/^PLURNK_EXECS_[A-Za-z0-9_]+$/.test(k)) throw new Error(`session.create: settings.execs key '${k}' is not a PLURNK_EXECS_* flag`);
                if (/^PLURNK_EXECS_MCP_/i.test(k)) throw new Error(`session.create: settings.execs may not carry MCP server config '${k}' — those are not policy and must not ride the wire`);
                if (typeof v !== "string") throw new Error(`session.create: settings.execs['${k}'] must be a string`);
                execs[k] = v;
            }
            out.execs = execs;
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
