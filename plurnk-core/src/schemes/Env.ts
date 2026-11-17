// {§env-functionality} — the environment registry as a referentially transparent address space:
// `env:///NAME` addresses the workspace scope (including unmasked service ceiling defaults), and
// `env://<session>/NAME` addresses explicit overrides in `<session>`.
import { isRecord, PathSyntax, type FindStatement, type KillStatement, type ParsedPath } from "@plurnk/plurnk-contracts";
import { parsePath } from "@plurnk/plurnk-parser";
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

export interface EnvWorkspaceRegistry {
    readonly env: NodeJS.ProcessEnv;
    readonly record: Readonly<Record<string, EnvRecord>>;
}

export interface EnvSessionTarget {
    readonly id: number;
    readonly name: string;
    readonly origin: string;
}

export type EnvWriteVerb = "replace" | "remove" | "disable";
export type EnvWriteIdentity =
    | { readonly workspaceId: number; readonly sessionId: number; readonly scope: "session" }
    | { readonly workspaceId: number; readonly scope: "workspace" };

export interface EnvSchemePort {
    readonly resolveWorkspace: (workspaceId: number) => Promise<EnvWorkspaceRegistry>;
    readonly resolveSession: (workspaceId: number, authority: string) => Promise<EnvSessionTarget | null>;
    readonly sessionOverrides: (workspaceId: number, sessionId: number) => Promise<Readonly<Record<string, string>>>;
    readonly listSessionScopes: (workspaceId: number) => Promise<ReadonlyArray<{
        readonly name: string;
        readonly overrides: Readonly<Record<string, string>>;
    }>>;
    readonly writeProjection: (workspaceId: number, authority: string, pathname: string, value: string) => Promise<SchemeResult>;
    readonly deleteProjection: (workspaceId: number, authority: string, pathname: string) => Promise<void>;
    readonly invoke: (verb: EnvWriteVerb, params: unknown, identity: EnvWriteIdentity) => Promise<unknown>;
}

const OWNER = "scheme:env";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// {§execution-output-identity} — the manager's own output streams, which stay the executor's.
const STREAM = /^[0-9a-f]{8}$/u;
const ADDRESS = /^env:\/\/([^/]*)(\/.*)$/iu;

const nameOf = (pathname: string): string | null => {
    const name = pathname.replace(/^\//u, "");
    return NAME.test(name) && !STREAM.test(name) ? name : null;
};

export default class EnvScheme implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]> = {
        authority: "resource",
        channels: {},
        defaultChannel: "body",
        folderScopes: true,
        writableBy: ["model", "client", "_plurnk"],
    };
    readonly #port: EnvSchemePort;

    constructor(port: EnvSchemePort) {
        this.#port = port;
    }

    // The registry is the namespace: every coordinate but the manager's own output streams.
    claims(pathname: string): boolean {
        return !STREAM.test(pathname.replace(/^\//u, ""));
    }

    static #named(target: ParsedPath | null): { authority: string; name: string; pathname: string; uri: string } | SchemeResult {
        if (target === null || target.kind !== "url") {
            return Results.failure(OWNER, "target-required", 400, "The operation needs an env:///NAME or env://<session>/NAME target.", {}, { retryable: false });
        }
        if (target.username !== null || target.password !== null || target.port !== null || target.query !== null) {
            return EnvScheme.#invalid(target.raw);
        }
        const authority = target.hostname ?? "";
        const name = nameOf(target.pathname);
        if (name === null) return EnvScheme.#invalid(target.raw);
        return {
            authority,
            name,
            pathname: `/${name}`,
            uri: `env://${authority}/${name}`,
        };
    }

    static #invalid(target: string): SchemeResult {
        return Results.failure(
            OWNER,
            "name-invalid",
            400,
            `'${target}' is not a valid env resource; use env:///NAME or env://<session>/NAME.`,
            {},
            { target, retryable: false },
        );
    }

    static #missing(uri: string, detail: string): SchemeResult {
        return Results.failure(OWNER, "entry-not-found", 404, detail, {}, { target: uri });
    }

    static #sessionMissing(authority: string, target: string): SchemeResult {
        return Results.failure(
            OWNER,
            "session-not-found",
            404,
            `Session '${authority}' does not exist in this workspace.`,
            {},
            { target, session: authority, retryable: false },
        );
    }

    static #whole(uri: string, op: "edit" | "kill"): SchemeResult {
        return Results.failure(OWNER, "value-whole", 400, `${uri} is one value: a scope or a pattern selects nothing in it.`, {}, {
            target: uri,
            retryable: false,
            recovery: op === "edit"
                ? `mcp({ server: "plurnk", tool: "edit", arguments: { path: "${uri}", text: "..." } }) sets the whole value.`
                : `mcp({ server: "plurnk", tool: "kill", arguments: { path: "${uri}" } }) retires the name.`,
        });
    }

    async #write(verb: EnvWriteVerb, params: unknown, identity: EnvWriteIdentity): Promise<SchemeResult | null> {
        try {
            await this.#port.invoke(verb, params, identity);
            return null;
        } catch (cause) {
            if (cause instanceof OperationFailureError) return cause.result;
            throw cause;
        }
    }

    async #syncScope(
        workspaceId: number,
        authority: string,
        desired: Readonly<Record<string, string | undefined>>,
        storedPaths: ReadonlySet<string>,
    ): Promise<void> {
        const prefix = `env://${authority}/`;
        for (const path of storedPaths) {
            if (!path.startsWith(prefix)) continue;
            const pathname = ADDRESS.exec(path)?.[2];
            const name = pathname === undefined ? null : nameOf(pathname);
            if (name !== null && desired[name] === undefined) {
                await this.#port.deleteProjection(workspaceId, authority, `/${name}`);
            }
        }
        for (const [name, value] of Object.entries(desired)) {
            if (value !== undefined && nameOf(`/${name}`) !== null) {
                await this.#port.writeProjection(workspaceId, authority, `/${name}`, value);
            }
        }
    }

    // READ projects `env:///NAME` (workspace + unmasked service ceiling) or `env://<session>/NAME`
    // (explicit session overrides only; returns 404 when NAME exists only in `env:///NAME`).
    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        if (
            request.target.kind !== "url"
            || request.target.username !== null
            || request.target.password !== null
            || request.target.port !== null
            || request.target.query !== null
        ) {
            return EnvScheme.#invalid(`env://${request.authority}${request.pathname}`);
        }
        const name = nameOf(request.pathname);
        if (name === null) return EnvScheme.#invalid(`env://${request.authority}${request.pathname}`);
        const uri = `env://${request.authority}/${name}`;

        if (request.authority === "") {
            const value = (await this.#port.resolveWorkspace(ctx.workspaceId)).env[name];
            if (value === undefined) {
                await this.#port.deleteProjection(ctx.workspaceId, "", request.pathname);
                return EnvScheme.#missing(uri, `No name ${name} is in effect at ${uri}.`);
            }
            const written = await ctx.entries.write(request.pathname, {
                channels: { body: { content: value, mimetype: "text/plain" } },
            });
            return written.status >= 400 ? { status: written.status, problem: written.problem } : { status: 200 };
        }

        const session = await this.#port.resolveSession(ctx.workspaceId, request.authority);
        if (session === null) return EnvScheme.#sessionMissing(request.authority, uri);
        if (session.origin === "_plurnk") {
            await this.#port.deleteProjection(ctx.workspaceId, request.authority, request.pathname);
            return EnvScheme.#missing(uri, `Session '_plurnk' keeps no session environment overrides; read env:///${name}.`);
        }
        const overrides = await this.#port.sessionOverrides(ctx.workspaceId, session.id);
        const value = overrides[name];
        if (value === undefined) {
            await this.#port.deleteProjection(ctx.workspaceId, request.authority, request.pathname);
            return EnvScheme.#missing(uri, `No session override ${name} is set at ${uri}.`);
        }
        const written = await ctx.entries.write(request.pathname, {
            channels: { body: { content: value, mimetype: "text/plain" } },
        });
        return written.status >= 400 ? { status: written.status, problem: written.problem } : { status: 200 };
    }

    // FIND materializes the requested scope (`env:///*`, `env://<session>/*`, or wildcard `env://**`).
    async prepareFind(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const authority = statement.target?.kind === "url" ? (statement.target.hostname ?? "") : "";
        const allTarget = parsePath("env://**");
        const stored = await ctx.entries.operations.find({
            ...statement,
            target: allTarget,
            matcher: null,
            lineMarker: { marks: [1, -1] },
        });
        const storedPaths = new Set<string>();
        if (stored.status === 200) {
            for (const item of stored.results) {
                const first: unknown = Array.isArray(item) ? item[0] : undefined;
                if (isRecord(first) && typeof first.path === "string") storedPaths.add(first.path);
            }
        }

        if (authority === "") {
            const { env } = await this.#port.resolveWorkspace(ctx.workspaceId);
            await this.#syncScope(ctx.workspaceId, "", env, storedPaths);
            return { status: 200 };
        }

        if (!PathSyntax.hasGlob(authority)) {
            const session = await this.#port.resolveSession(ctx.workspaceId, authority);
            if (session === null) return EnvScheme.#sessionMissing(authority, statement.target?.raw ?? `env://${authority}/*`);
            const overrides = session.origin === "_plurnk" ? {} : await this.#port.sessionOverrides(ctx.workspaceId, session.id);
            await this.#syncScope(ctx.workspaceId, session.name, overrides, storedPaths);
            return { status: 200 };
        }

        const { env } = await this.#port.resolveWorkspace(ctx.workspaceId);
        await this.#syncScope(ctx.workspaceId, "", env, storedPaths);
        const sessions = await this.#port.listSessionScopes(ctx.workspaceId);
        const activeAuthorities = new Set<string>(["", ...sessions.map((s) => s.name)]);
        for (const path of storedPaths) {
            const match = ADDRESS.exec(path);
            if (match !== null && !activeAuthorities.has(match[1])) {
                await this.#port.deleteProjection(ctx.workspaceId, match[1], match[2]);
            }
        }
        for (const session of sessions) {
            await this.#syncScope(ctx.workspaceId, session.name, session.overrides, storedPaths);
        }
        return { status: 200 };
    }

    // {§functionality-replacement} — EDIT assigns a whole value without changing enabledness:
    // `env:///NAME` always writes workspace scope; `env://<session>/NAME` writes `<session>`'s scope.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (statement === undefined || statements.length > 1) {
            return Results.failure(OWNER, "value-whole", 400, "One edit sets one value, whole.", {}, {
                recovery: "mcp({ server: \"plurnk\", tool: \"edit\", arguments: { path: \"env:///NAME\", text: \"...\" } }) sets one value per statement.",
                retryable: false,
            });
        }
        const named = EnvScheme.#named(statement.target);
        if ("status" in named) return named;
        if (statement.lineMarker !== null || statement.matcher !== null) return EnvScheme.#whole(named.uri, "edit");

        if (named.authority === "") {
            const refused = await this.#write(
                "replace",
                { alias: named.name, value: statement.body ?? "" },
                { workspaceId: ctx.workspaceId, scope: "workspace" },
            );
            if (refused !== null) return refused;
            await this.#port.deleteProjection(ctx.workspaceId, "", named.pathname);
            return { status: 200 };
        }

        const session = await this.#port.resolveSession(ctx.workspaceId, named.authority);
        if (session === null) return EnvScheme.#sessionMissing(named.authority, named.uri);
        if (session.origin === "_plurnk") {
            return Results.failure(
                OWNER,
                "session-unsupported",
                400,
                `Session '_plurnk' keeps no session environment overrides; edit env:///${named.name} instead.`,
                {},
                {
                    target: named.uri,
                    recovery: `mcp({ server: "plurnk", tool: "edit", arguments: { path: "env:///${named.name}", text: "..." } })`,
                    retryable: false,
                },
            );
        }
        const refused = await this.#write(
            "replace",
            { alias: named.name, value: statement.body ?? "" },
            { workspaceId: ctx.workspaceId, sessionId: session.id, scope: "session" },
        );
        if (refused !== null) return refused;
        await this.#port.deleteProjection(ctx.workspaceId, session.name, named.pathname);
        return { status: 200 };
    }

    // KILL retires `env:///NAME` from workspace scope (`remove` when workspace-owned, `disable` when
    // inherited from service ceiling) or removes `env://<session>/NAME` from `<session>`'s overrides.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const named = EnvScheme.#named(statement.target);
        if ("status" in named) return named;
        if (statement.lineMarker !== null || statement.matcher !== null) return EnvScheme.#whole(named.uri, "kill");

        if (named.authority === "") {
            const entry = (await this.#port.resolveWorkspace(ctx.workspaceId)).record[named.name];
            if (entry === undefined || entry.source === "masked" || entry.value === undefined) {
                return EnvScheme.#missing(named.uri, `No name ${named.name} is in effect at ${named.uri}.`);
            }
            const refused = await this.#write(
                entry.source === "workspace" ? "remove" : "disable",
                { alias: named.name },
                { workspaceId: ctx.workspaceId, scope: "workspace" },
            );
            if (refused !== null) return refused;
            await this.#port.deleteProjection(ctx.workspaceId, "", named.pathname);
            return { status: 200 };
        }

        const session = await this.#port.resolveSession(ctx.workspaceId, named.authority);
        if (session === null) return EnvScheme.#sessionMissing(named.authority, named.uri);
        if (session.origin === "_plurnk") {
            return EnvScheme.#missing(named.uri, `Session '_plurnk' keeps no session environment overrides.`);
        }
        const overrides = await this.#port.sessionOverrides(ctx.workspaceId, session.id);
        if (overrides[named.name] === undefined) {
            return EnvScheme.#missing(named.uri, `No session override ${named.name} is set at ${named.uri}.`);
        }
        const refused = await this.#write(
            "remove",
            { alias: named.name },
            { workspaceId: ctx.workspaceId, sessionId: session.id, scope: "session" },
        );
        if (refused !== null) return refused;
        await this.#port.deleteProjection(ctx.workspaceId, session.name, named.pathname);
        return { status: 200 };
    }
}
