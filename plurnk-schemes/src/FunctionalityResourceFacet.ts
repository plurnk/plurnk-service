// {§resource-tree-scheme} Shared RuntimeSchemeFacet for workspace Functionality definition resources
// (`schedule:///rules/<alias>`, `mcp:///servers/<alias>`, `members:///<glob>`).
import {
    Problems,
    Validator,
    isRecord,
    type FindStatement,
    type FunctionalityFamilyHandle,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import Results, { type RepresentationPreparationResult, type SchemeResult } from "./Results.ts";
import type { SchemeCtx } from "./ctx.ts";
import type { EditBatchResult, ResolvedEditStatement } from "./edit-receipt.ts";
import type { RepresentationPreparationRequest, RuntimeSchemeFacet } from "./handler.ts";

export interface FunctionalityEditInvocation {
    readonly verb: "add" | "replace";
    readonly params: Readonly<Record<string, unknown>>;
}

export interface FunctionalityResourceFacetOptions {
    readonly owner: string;
    readonly scheme: string;
    readonly handle: () => FunctionalityFamilyHandle | null;
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]>;
    readonly claims: (pathname: string) => boolean;
    readonly aliasFromPathname: (pathname: string) => string | null;
    readonly pathnameOfAlias: (alias: string) => string;
    readonly authorityDetail: string;
    readonly notFoundDetail: string;
    readonly wholeEditDetail: string;
    readonly wholeKillDetail: string;
    readonly invalidTarget?: {
        readonly code: string;
        readonly detail: string;
    };
    readonly toEditInvocation: (alias: string, rawBody: string | null) => FunctionalityEditInvocation | SchemeResult;
    readonly selectParams?: (alias: string) => Readonly<Record<string, unknown>>;
}

export default class FunctionalityResourceFacet implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]>;
    readonly #options: FunctionalityResourceFacetOptions;
    readonly #addressPattern: RegExp;

    constructor(options: FunctionalityResourceFacetOptions) {
        this.manifest = options.manifest;
        this.#options = options;
        this.#addressPattern = new RegExp(`^${RegExp.escape(options.scheme)}://[^/]*(\\/.*)$`, "iu");
    }

    static jsonReplaceInvocation(
        owner: string,
        invalidBodyDetail: string,
    ): (alias: string, rawBody: string | null) => FunctionalityEditInvocation | SchemeResult {
        return (alias, rawBody) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(rawBody ?? "");
            } catch {
                return Results.failure(owner, "definition-invalid", 400, invalidBodyDetail, {}, { retryable: false });
            }
            if (!isRecord(parsed)) {
                return Results.failure(owner, "definition-invalid", 400, invalidBodyDetail, {}, { retryable: false });
            }
            return {
                verb: "replace",
                params: { ...parsed, alias },
            };
        };
    }

    claims(pathname: string): boolean {
        return this.#options.claims(pathname);
    }

    #requireHandle(): FunctionalityFamilyHandle {
        const handle = this.#options.handle();
        if (handle === null) throw new Error(`${this.#options.scheme} family is not attached`);
        return handle;
    }

    #named(target: ParsedPath | null): { readonly alias: string; readonly pathname: string } | SchemeResult {
        const { owner, invalidTarget, authorityDetail, notFoundDetail, aliasFromPathname } = this.#options;
        if (target === null || target.kind !== "url" || (target.hostname ?? "") !== "") {
            const code = invalidTarget?.code ?? "authority-invalid";
            const detail = invalidTarget?.detail ?? authorityDetail;
            return Results.failure(owner, code, 400, detail, {}, { retryable: false });
        }
        const alias = aliasFromPathname(target.pathname);
        if (alias === null) {
            return Results.failure(owner, "not-found", 404, notFoundDetail, {}, {
                target: target.raw,
                retryable: false,
            });
        }
        return { alias, pathname: target.pathname };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const { owner, authorityDetail, notFoundDetail, aliasFromPathname } = this.#options;
        if (request.authority !== "") {
            return Results.failure(owner, "authority-invalid", 400, authorityDetail);
        }
        const alias = aliasFromPathname(request.pathname);
        if (alias === null) {
            return Results.failure(owner, "not-found", 404, notFoundDetail);
        }
        const listing = await this.#requireHandle().invoke("list", {}, { workspaceId: ctx.workspaceId });
        const content = Validator.assertFunctionalityListResult(listing.body).definitions.find(
            (entry) => entry.alias === alias,
        );
        if (content === undefined) {
            await ctx.entries.delete(request.pathname);
            return Results.failure(owner, "not-found", 404, notFoundDetail);
        }
        const result = await ctx.entries.write(request.pathname, {
            channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } },
        });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }

    async prepareFind(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const listing = await this.#requireHandle().invoke("list", {}, { workspaceId: ctx.workspaceId });
        const definitions = Validator.assertFunctionalityListResult(listing.body).definitions;
        const activeAliases = new Set(definitions.map((item) => item.alias));
        const stored = await ctx.entries.operations.find({
            ...statement,
            matcher: null,
            lineMarker: { marks: [1, -1] },
        });
        if (stored.status === 200) {
            for (const item of stored.results) {
                const first: unknown = Array.isArray(item) ? item[0] : undefined;
                const path = isRecord(first) && typeof first.path === "string" ? first.path : undefined;
                const pathname = path === undefined ? undefined : this.#addressPattern.exec(path)?.[1];
                const alias = pathname === undefined ? null : this.#options.aliasFromPathname(pathname);
                if (alias !== null && pathname !== undefined && !activeAliases.has(alias)) {
                    await ctx.entries.delete(pathname);
                }
            }
        }
        for (const content of definitions) {
            const pathname = this.#options.pathnameOfAlias(content.alias);
            await ctx.entries.write(pathname, {
                channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } },
            });
        }
        return { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (
            statement === undefined
            || statements.length > 1
            || statement.lineMarker !== null
            || statement.matcher !== null
        ) {
            return Results.failure(
                this.#options.owner,
                "value-whole",
                400,
                this.#options.wholeEditDetail,
                {},
                { retryable: false },
            );
        }
        const named = this.#named(statement.target);
        if ("status" in named) return named;
        const invocation = this.#options.toEditInvocation(named.alias, statement.body);
        if ("status" in invocation) return invocation;
        try {
            await this.#requireHandle().invoke(
                invocation.verb,
                invocation.params,
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }

    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        if (statement.lineMarker !== null || statement.matcher !== null) {
            return Results.failure(
                this.#options.owner,
                "value-whole",
                400,
                this.#options.wholeKillDetail,
                {},
                { retryable: false },
            );
        }
        const named = this.#named(statement.target);
        if ("status" in named) return named;
        const handle = this.#requireHandle();
        const listing = await handle.invoke("list", {}, { workspaceId: ctx.workspaceId });
        const existing = Validator.assertFunctionalityListResult(listing.body).definitions.find(
            (entry) => entry.alias === named.alias,
        );
        if (existing?.origin === "service" && existing.state === "disabled") {
            await ctx.entries.delete(named.pathname);
            return Results.failure(this.#options.owner, "not-found", 404, this.#options.notFoundDetail, {}, {
                ...(statement.target === null ? {} : { target: statement.target.raw }),
                retryable: false,
            });
        }
        const verb = existing?.origin === "service" ? "disable" : "remove";
        const params = this.#options.selectParams ? this.#options.selectParams(named.alias) : { alias: named.alias };
        try {
            await handle.invoke(
                verb,
                params,
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(named.pathname);
        return { status: 200 };
    }
}
