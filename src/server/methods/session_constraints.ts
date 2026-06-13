import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import GitMembership from "../../core/git-membership.ts";

// Client tooling for the SPEC §membership constraint overlay — the supersede over git
// membership. `constrain`/`unconstrain` mutate session_constraints then re-resolve
// membership so the change lands now, not next turn; `constraints` lists them.
const EFFECTS: ReadonlySet<string> = new Set(["add", "ignore", "read-only"]);

export default class SessionConstraintsMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.constrain", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("session.constrain requires an attached session");
                const { effect, glob } = SessionConstraintsMethod.#parse(params, "session.constrain");
                await (ctx.db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.session.sessionId, effect, glob });
                await GitMembership.resolveGitMembership(ctx.db, ctx.session.sessionId, undefined);
                return { effect, glob };
            },
            description: "Add a workspace membership constraint (SPEC §membership overlay): `add` admits files git misses (the sole source when git is absent), `ignore` drops tracked matches, `read-only` admits a member for read but refuses edits. Takes effect immediately.",
            params: {
                effect: "string — one of: add | ignore | read-only",
                glob: "string — node:path glob matched against workspace-relative paths",
            },
            requiresInit: true,
        });
        registry.registerMethod("session.unconstrain", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("session.unconstrain requires an attached session");
                const { effect, glob } = SessionConstraintsMethod.#parse(params, "session.unconstrain");
                await (ctx.db.crud_delete_session_constraint as PrepMethod).run({ session_id: ctx.session.sessionId, effect, glob });
                await GitMembership.resolveGitMembership(ctx.db, ctx.session.sessionId, undefined);
                return { effect, glob };
            },
            description: "Remove a workspace membership constraint — the inverse of session.constrain (the `remove` verb is deleting the constraint row). Takes effect immediately.",
            params: {
                effect: "string — one of: add | ignore | read-only",
                glob: "string — the glob to remove",
            },
            requiresInit: true,
        });
        registry.registerMethod("session.constraints", {
            handler: async (_params, ctx) => {
                if (ctx.session === null) throw new Error("session.constraints requires an attached session");
                const constraints = await (ctx.db.crud_list_session_constraints as PrepMethod).all<{ effect: string; glob: string }>({ session_id: ctx.session.sessionId });
                return { constraints };
            },
            description: "List the workspace membership constraints on the attached session.",
            params: {},
            requiresInit: true,
        });
    }

    static #parse(params: unknown, method: string): { effect: string; glob: string } {
        const p = params as { effect?: unknown; glob?: unknown };
        if (typeof p.effect !== "string" || !EFFECTS.has(p.effect)) {
            throw new Error(`${method}: effect must be one of add | ignore | read-only`);
        }
        if (typeof p.glob !== "string" || p.glob.length === 0) {
            throw new Error(`${method}: glob must be a non-empty string`);
        }
        return { effect: p.effect, glob: p.glob };
    }
}
