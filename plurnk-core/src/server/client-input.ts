// Client-input validation at the SEAM — the daemon's client surface fail-hards on malformed
// input for EVERY module riding it (#364 flushed these out of the retired WS handlers, where
// only the socket path got them). Messages are the client-facing contract; tests assert them.
import { isAbsolute } from "node:path";

const CONSTRAINT_EFFECTS: ReadonlySet<string> = new Set(["pick", "hide", "view", "repo"]);

export default class ClientInput {
    // A workspace pin must be an absolute path (or null = headless) — a relative root would
    // silently resolve against the daemon's cwd, never the client's.
    static assertProjectRoot(context: string, projectRoot: unknown): string | null {
        const root = (projectRoot as string | null | undefined) ?? null;
        if (root === null) return null;
        if (typeof root !== "string" || root.length === 0) {
            throw new Error(`${context}: projectRoot must be a non-empty string or null`);
        }
        if (!isAbsolute(root)) throw new Error(`${context}: projectRoot must be an absolute path`);
        return root;
    }

    static assertConstraint(context: string, effect: unknown, glob: unknown): void {
        if (typeof effect !== "string" || !CONSTRAINT_EFFECTS.has(effect)) {
            throw new Error(`${context}: effect must be one of pick | hide | view | repo`);
        }
        if (typeof glob !== "string" || glob.length === 0) {
            throw new Error(`${context}: glob must be a non-empty string`);
        }
    }

    static parseConstraints(raw: unknown): Array<{ effect: string; glob: string }> {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new Error("workspace.create: constraints must be an array");
        return raw.map((c, i) => {
            const e = c as { effect?: unknown; glob?: unknown };
            if (typeof e.effect !== "string" || !CONSTRAINT_EFFECTS.has(e.effect)) {
                throw new Error(`workspace.create: constraints[${i}].effect must be one of pick | hide | view | repo`);
            }
            if (typeof e.glob !== "string" || e.glob.length === 0) {
                throw new Error(`workspace.create: constraints[${i}].glob must be a non-empty string`);
            }
            return { effect: e.effect, glob: e.glob };
        });
    }

    // §wait — loop flags are booleans (mode aside); a truthy string silently flipping auto-approval would
    // be a review-bypass, so the shape fail-hards at the surface.
    static normalizeLoopFlags(context: string, flags: unknown): Record<string, unknown> | undefined {
        if (flags === undefined) return undefined;
        if (typeof flags !== "object" || flags === null || Array.isArray(flags)) {
            throw new Error(`${context}: flags must be an object`);
        }
        const f = flags as Record<string, unknown>;
        const booleanFlags = new Set(["auto", "noProposals", "noWeb", "noInteraction"]);
        const allowed = new Set([...booleanFlags, "mode"]);
        for (const key of Object.keys(f)) {
            if (!allowed.has(key)) throw new Error(`${context}: flags.${key} is not supported`);
        }
        for (const bool of booleanFlags) {
            if (f[bool] !== undefined && typeof f[bool] !== "boolean") {
                throw new Error(`${context}: flags.${bool} must be a boolean`);
            }
        }
        if (f.mode !== undefined && f.mode !== "ask" && f.mode !== "act") {
            throw new Error(`${context}: flags.mode must be 'ask' or 'act'`);
        }
        return f;
    }

    // #231 — validate + serialize the client open-context bag. filesItems is a scalar (replace);
    // mdDocs is [{alias, content}] (union'd with env at turn-0). A pre-serialized string passes
    // through (a module may serialize at its own edge).
    static parseSettings(raw: unknown): string {
        if (raw === undefined || raw === null) return "{}";
        if (typeof raw === "string") return raw;
        if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("workspace.create: settings must be an object");
        const r = raw as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; mdDocs?: unknown; client?: unknown; execs?: unknown; questions?: unknown };
        const out: { filesItems?: number; maxCommands?: number; git?: boolean; mdDocs?: Array<{ alias: string; content: string }>; client?: string; execs?: Record<string, string>; questions?: boolean } = {};
        if (r.filesItems !== undefined) {
            if (typeof r.filesItems !== "number" || !Number.isInteger(r.filesItems)) {
                throw new Error("workspace.create: settings.filesItems must be an integer (-1 full | 0 off | N first-N)");
            }
            out.filesItems = r.filesItems;
        }
        // #232 — tighten-only ceilings: a client may narrow, never widen (composed
        // most-restrictive-wins at each read-site). maxCommands min()s the env ceiling;
        // git:false denies git for the workspace (env AND workspace).
        if (r.maxCommands !== undefined) {
            if (typeof r.maxCommands !== "number" || !Number.isInteger(r.maxCommands) || r.maxCommands < 0) {
                throw new Error("workspace.create: settings.maxCommands must be a non-negative integer (a tighten-only ceiling; 0 = plan + conclude only, no actions)");
            }
            out.maxCommands = r.maxCommands;
        }
        if (r.git !== undefined) {
            if (typeof r.git !== "boolean") throw new Error("workspace.create: settings.git must be a boolean (false denies git for the workspace)");
            out.git = r.git;
        }
        // §send-300-choices — operator questions: the client AFFIRMATIVELY requests them per
        // workspace (its own PLURNK_QUESTIONS=1 forwarded); enabled = allowed (service env) AND this.
        if (r.questions !== undefined) {
            if (typeof r.questions !== "boolean") throw new Error("workspace.create: settings.questions must be a boolean (operator questions — [300] — requested for this workspace)");
            out.questions = r.questions;
        }
        // #249 — workspace-stable frontend id (e.g. "plurnk.nvim/1.4.0"), forwarded to the plurnk
        // provider as Plurnk-Client metadata; ignored by every other provider. Self-identified.
        if (r.client !== undefined) {
            if (typeof r.client !== "string" || r.client.length === 0) {
                throw new Error("workspace.create: settings.client must be a non-empty string (the frontend id, e.g. 'plurnk.nvim/1.4.0')");
            }
            out.client = r.client;
        }
        // #328 — the client's resolved PLURNK_EXECS_* policy subset, verbatim key→value, fed to execs'
        // Policy as the per-workspace client layer (subtractive: narrows the boot-registered set, never
        // widens). PLURNK_EXECS_MCP_* (server URLs + _HEADERS tokens) MUST NOT ride the wire — refused
        // here as defense-in-depth even though the client already excludes them (the bare MCP toggle stays).
        if (r.execs !== undefined) {
            if (typeof r.execs !== "object" || r.execs === null || Array.isArray(r.execs)) {
                throw new Error("workspace.create: settings.execs must be an object of PLURNK_EXECS_* key→value strings");
            }
            const execs: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.execs as Record<string, unknown>)) {
                if (!/^PLURNK_EXECS_[A-Za-z0-9_]+$/.test(k)) throw new Error(`workspace.create: settings.execs key '${k}' is not a PLURNK_EXECS_* flag`);
                if (/^PLURNK_EXECS_MCP_/i.test(k)) throw new Error(`workspace.create: settings.execs may not carry MCP server config '${k}' — those are not policy and must not ride the wire`);
                if (typeof v !== "string") throw new Error(`workspace.create: settings.execs['${k}'] must be a string`);
                execs[k] = v;
            }
            out.execs = execs;
        }
        if (r.mdDocs !== undefined) {
            if (!Array.isArray(r.mdDocs)) throw new Error("workspace.create: settings.mdDocs must be an array");
            out.mdDocs = r.mdDocs.map((d, i) => {
                const e = d as { alias?: unknown; content?: unknown };
                if (typeof e.alias !== "string" || e.alias.length === 0 || /[^\w.-]/.test(e.alias)) {
                    throw new Error(`workspace.create: settings.mdDocs[${i}].alias must be a non-empty [\\w.-] string`);
                }
                if (typeof e.content !== "string") throw new Error(`workspace.create: settings.mdDocs[${i}].content must be a string`);
                return { alias: e.alias, content: e.content };
            });
        }
        return JSON.stringify(out);
    }
}
