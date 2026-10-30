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

const OWNER = "schedule:resource";
const ALIAS_PATH = /^\/(?:rules\/)?([^/]+)$/u;

const aliasFromPath = (pathname: string): string | null => {
    if (pathname === "/rules" || pathname === "/outputs" || pathname.startsWith("/outputs/")) return null;
    const match = ALIAS_PATH.exec(pathname);
    if (match === null) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
};

// The rule resources, `schedule:///rules/<alias>` (or `schedule:///<alias>`); an occurrence is a message, never a wait.
export default class ScheduleResources implements RuntimeSchemeFacet {
    readonly manifest: NonNullable<RuntimeSchemeFacet["manifest"]> = {
        writableBy: ["model", "client"],
    };

    readonly #handle: () => FunctionalityFamilyHandle | null;

    constructor(handle: () => FunctionalityFamilyHandle | null) {
        this.#handle = handle;
    }

    #requireHandle(): FunctionalityFamilyHandle {
        const handle = this.#handle();
        if (handle === null) throw new Error("schedule family is not attached");
        return handle;
    }

    claims(pathname: string): boolean {
        return /^\/rules(?:\/|$)/u.test(pathname) || aliasFromPath(pathname) !== null;
    }

    static #named(target: ParsedPath | null): { alias: string; pathname: string } | SchemeResult {
        if (target === null || target.kind !== "url" || (target.hostname ?? "") !== "") {
            return Results.failure(OWNER, "authority-invalid", 400, "Schedule resources use an empty authority.", {}, { retryable: false });
        }
        const alias = aliasFromPath(target.pathname);
        if (alias === null) {
            return Results.failure(OWNER, "not-found", 404, "The schedule resource does not exist.", {}, { target: target.raw, retryable: false });
        }
        return { alias, pathname: target.pathname };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.authority !== "") {
            return Results.failure(OWNER, "authority-invalid", 400, "Schedule resources use an empty authority.");
        }
        const alias = aliasFromPath(request.pathname);
        if (alias === null) {
            return Results.failure(OWNER, "not-found", 404, "The schedule resource does not exist.");
        }
        const listing = await this.#requireHandle().invoke("list", {}, { workspaceId: ctx.workspaceId });
        const content = Validator.assertFunctionalityListResult(listing.body).definitions.find((rule) => rule.alias === alias);
        if (content === undefined) {
            return Results.failure(OWNER, "not-found", 404, "The schedule resource does not exist.");
        }
        const result = await ctx.entries.write(request.pathname, {
            channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } },
        });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (statement === undefined || statements.length > 1 || statement.lineMarker !== null || statement.matcher !== null) {
            return Results.failure(OWNER, "value-whole", 400, "One EDIT sets one schedule definition, whole.", {}, { retryable: false });
        }
        const named = ScheduleResources.#named(statement.target);
        if ("status" in named) return named;
        let parsed: unknown;
        try {
            parsed = JSON.parse(statement.body ?? "");
        } catch {
            return Results.failure(OWNER, "definition-invalid", 400, "The schedule definition body must be a JSON object.", {}, { retryable: false });
        }
        if (!isRecord(parsed)) {
            return Results.failure(OWNER, "definition-invalid", 400, "The schedule definition body must be a JSON object.", {}, { retryable: false });
        }
        try {
            await this.#requireHandle().invoke(
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
            return Results.failure(OWNER, "value-whole", 400, "KILL retires the whole schedule definition.", {}, { retryable: false });
        }
        const named = ScheduleResources.#named(statement.target);
        if ("status" in named) return named;
        try {
            await this.#requireHandle().invoke(
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
