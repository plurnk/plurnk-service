import {
    Problems,
    Validator,
    isRecord,
    type FunctionalityFamilyHandle,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
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

const OWNER = "mcp:resource";

const aliasOfPathname = (pathname: string): string | null => {
    const rest = pathname.startsWith("/servers/")
        ? pathname.slice("/servers/".length)
        : pathname.startsWith("/")
            ? pathname.slice(1)
            : "";
    if (rest.length === 0 || rest === "servers" || rest.includes("/")) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
};

export default class McpFamilyResources implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]> = {
        channels: { results: "application/json" },
        defaultChannel: "results",
        writableBy: ["model", "client"],
    };
    readonly #handle: () => FunctionalityFamilyHandle;

    constructor(handle: () => FunctionalityFamilyHandle) {
        this.#handle = handle;
    }

    claims(pathname: string): boolean {
        if (pathname.endsWith(".md") || pathname.endsWith(".json")) return false;
        return /^\/(?:servers(?:\/|$)|[^/]+$)/u.test(pathname);
    }

    static #named(target: ParsedPath | null): { alias: string; pathname: string } | SchemeResult {
        if (target === null || target.kind !== "url" || (target.hostname ?? "") !== "") {
            return Results.failure(OWNER, "target-required", 400, "The operation needs an mcp:///servers/<alias> target.", {}, { retryable: false });
        }
        const alias = aliasOfPathname(target.pathname);
        if (alias === null) {
            return Results.failure(OWNER, "not-found", 404, "The MCP server resource does not exist.", {}, { target: target.raw, retryable: false });
        }
        return { alias, pathname: target.pathname };
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        if (request.authority !== "") return Results.failure(OWNER, "authority-invalid", 400, "MCP server resources use an empty authority.");
        const alias = aliasOfPathname(request.pathname);
        if (alias === null) return Results.failure(OWNER, "not-found", 404, "The MCP server resource does not exist.");
        const listing = await this.#handle().invoke("list", {}, { workspaceId: ctx.workspaceId });
        const content = Validator.assertFunctionalityListResult(listing.body).definitions.find((entry) => entry.alias === alias);
        if (content === undefined) return Results.failure(OWNER, "not-found", 404, "The MCP server resource does not exist.");
        const result = await ctx.entries.write(request.pathname, {
            channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } },
        });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (statement === undefined || statements.length > 1 || statement.lineMarker !== null || statement.matcher !== null) {
            return Results.failure(OWNER, "value-whole", 400, "One EDIT sets one MCP server definition, whole.", {}, { retryable: false });
        }
        const named = McpFamilyResources.#named(statement.target);
        if ("status" in named) return named;
        let parsed: unknown;
        try {
            parsed = JSON.parse(statement.body ?? "");
        } catch {
            return Results.failure(OWNER, "definition-invalid", 400, "The MCP server definition body must be a JSON object.", {}, { retryable: false });
        }
        if (!isRecord(parsed)) {
            return Results.failure(OWNER, "definition-invalid", 400, "The MCP server definition body must be a JSON object.", {}, { retryable: false });
        }
        try {
            await this.#handle().invoke(
                "replace",
                { ...parsed, alias: named.alias },
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
            return Results.failure(OWNER, "value-whole", 400, "KILL retires the whole MCP server definition.", {}, { retryable: false });
        }
        const named = McpFamilyResources.#named(statement.target);
        if ("status" in named) return named;
        try {
            await this.#handle().invoke(
                "remove",
                { alias: named.alias },
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
