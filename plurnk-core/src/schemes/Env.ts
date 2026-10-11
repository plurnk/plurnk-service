// {§env-scheme} — the environment registry as an address space: the facet of the env family's own
// namespace. Every name in effect for the dispatching Worker's commands is a resource at
// env:///NAME whose body is its value; a write is the family's own admission at the Worker's layer.
import type { FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import {
    Results,
    type EditBatchResult,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type ResolvedEditStatement,
    type RuntimeSchemeFacet,
    type SchemeCtx,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import { OperationFailureError } from "../core/results.ts";
import type { EnvRecord } from "../server/EnvFunctionality.ts";

export interface EnvRegistry {
    readonly env: NodeJS.ProcessEnv;
    readonly record: Readonly<Record<string, EnvRecord>>;
}
export type EnvResolve = (workspaceId: number, workerId: number) => Promise<EnvRegistry>;
export type EnvWriteVerb = "add" | "remove" | "disable";
export interface EnvWriteIdentity {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly scope: "worker";
}
export type EnvInvoke = (verb: EnvWriteVerb, params: unknown, identity: EnvWriteIdentity) => Promise<unknown>;

const OWNER = "scheme:env";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// {§execution-output-identity} — the manager's own output streams, which stay the executor's.
const STREAM = /^[0-9a-f]{8}$/u;
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/iu;

const nameOf = (pathname: string): string | null => {
    const name = pathname.replace(/^\//u, "");
    return NAME.test(name) && !STREAM.test(name) ? name : null;
};

export default class EnvScheme implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]> = {
        authority: "resource", channels: {}, defaultChannel: "body", writableBy: ["model", "client", "_plurnk"],
    };
    readonly #resolve: EnvResolve;
    readonly #invoke: EnvInvoke;

    constructor(resolve: EnvResolve, invoke: EnvInvoke) {
        this.#resolve = resolve;
        this.#invoke = invoke;
    }

    // The registry is the namespace: every coordinate but the manager's own output streams.
    claims(pathname: string): boolean {
        return !STREAM.test(pathname.replace(/^\//u, ""));
    }

    static #named(target: ParsedPath | null): { name: string; pathname: string } | SchemeResult {
        if (target === null || target.kind !== "url") {
            return Results.failure(OWNER, "target-required", 400, "The operation needs an env:///NAME target.", {}, { retryable: false });
        }
        const name = (target.hostname ?? "") === "" ? nameOf(target.pathname) : null;
        if (name === null) return EnvScheme.#invalid(target.raw);
        return { name, pathname: `/${name}` };
    }

    static #invalid(target: string): SchemeResult {
        return Results.failure(OWNER, "name-invalid", 400, `'${target}' is not a name a shell can export; the form is env:///NAME.`, {}, { target, retryable: false });
    }

    static #missing(name: string): SchemeResult {
        return Results.failure(OWNER, "entry-not-found", 404, `No name ${name} is in effect for this Worker's commands.`, {}, { target: `env:///${name}` });
    }

    static #whole(name: string, op: "EDIT" | "KILL"): SchemeResult {
        return Results.failure(OWNER, "value-whole", 400, `env:///${name} is one value: a scope or a pattern selects nothing in it.`, {}, {
            target: `env:///${name}`, retryable: false,
            recovery: op === "EDIT" ? `EDIT (env:///${name}) with the whole value as the body.` : `KILL (env:///${name}) retires the name.`,
        });
    }

    // The family's refusal is the operation's result.
    async #write(verb: EnvWriteVerb, params: unknown, ctx: SchemeCtx): Promise<SchemeResult | null> {
        try {
            await this.#invoke(verb, params, { workspaceId: ctx.workspaceId, workerId: ctx.workerId, scope: "worker" });
            return null;
        } catch (cause) {
            if (cause instanceof OperationFailureError) return cause.result;
            throw cause;
        }
    }

    #project(ctx: SchemeCtx, pathname: string, value: string): Promise<SchemeResult> {
        return ctx.entries.write(pathname, { channels: { body: { content: value, mimetype: "text/plain" } } });
    }

    // READ projects the value the Worker's commands receive now; a name no longer in effect
    // withdraws its projection.
    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        const name = request.authority === "" ? nameOf(request.pathname) : null;
        if (name === null) return EnvScheme.#invalid(`env://${request.authority}${request.pathname}`);
        const value = (await this.#resolve(ctx.workspaceId, ctx.workerId)).env[name];
        if (value === undefined) {
            await ctx.entries.delete(request.pathname);
            return EnvScheme.#missing(name);
        }
        const written = await this.#project(ctx, request.pathname, value);
        return written.status >= 400 ? { status: written.status, problem: written.problem } : { status: 200 };
    }

    // FIND lists exactly what is in effect: stored projections of names no longer in effect are
    // withdrawn and every current name is projected before the host selects among them.
    async prepareFind(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const { env } = await this.#resolve(ctx.workspaceId, ctx.workerId);
        const stored = await ctx.entries.operations.find({ ...statement, matcher: null, lineMarker: { marks: [1, -1] } });
        if (stored.status === 200) {
            for (const item of stored.results) {
                const path = Array.isArray(item) ? (item[0] as { path?: string }).path : undefined;
                const pathname = path === undefined ? undefined : ADDRESS.exec(path)?.[1];
                const name = pathname === undefined ? null : nameOf(pathname);
                if (name !== null && env[name] === undefined) await ctx.entries.delete(`/${name}`);
            }
        }
        for (const [name, value] of Object.entries(env)) {
            if (value !== undefined && nameOf(`/${name}`) !== null) await this.#project(ctx, `/${name}`, value);
        }
        return { status: 200 };
    }

    // EDIT sets the Worker's own value, whole, through the family's `add`.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (statement === undefined || statements.length > 1) {
            return Results.failure(OWNER, "value-whole", 400, "One EDIT sets one value, whole.", {}, {
                recovery: "EDIT (env:///NAME) with the value as the body, one statement per name.", retryable: false,
            });
        }
        const named = EnvScheme.#named(statement.target);
        if ("status" in named) return named;
        if (statement.lineMarker !== null || statement.matcher !== null) return EnvScheme.#whole(named.name, "EDIT");
        const refused = await this.#write("add", { alias: named.name, definition: { value: statement.body ?? "" } }, ctx);
        if (refused !== null) return refused;
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }

    // KILL retires the name from the Worker's commands: the family's `remove` for an entry the
    // Worker owns, its `disable` for an inherited one, whose definition is kept.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const named = EnvScheme.#named(statement.target);
        if ("status" in named) return named;
        if (statement.lineMarker !== null || statement.matcher !== null) return EnvScheme.#whole(named.name, "KILL");
        const entry = (await this.#resolve(ctx.workspaceId, ctx.workerId)).record[named.name];
        if (entry === undefined || entry.source === "masked" || entry.value === undefined) return EnvScheme.#missing(named.name);
        const refused = await this.#write(entry.source === "worker" ? "remove" : "disable", { alias: named.name }, ctx);
        if (refused !== null) return refused;
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }
}
