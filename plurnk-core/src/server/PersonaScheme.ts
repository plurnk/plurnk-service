// {§persona-discovery} — `persona://` resource-tree source (`READ`, `FIND`, `EDIT`, `KILL`).
import {
    PathSyntax,
    Problems,
    SKILL_NAME,
    Validator,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import {
    EntryCoordinates,
    Results as SchemeResults,
    type EditBatchResult,
    type EntryCoordinate,
    type RepresentationPreparationResult,
    type ResolvedEditStatement,
    type ResourceTree,
    type ResourceTreeSource,
    type SchemeCtx,
    type SchemeResult,
    type WriterTier,
} from "@plurnk/plurnk-schemes";
import { parsePersonaEditBody, type PersonaDefinition } from "./PersonaDefinition.ts";
import { personaTreeRefusal } from "./PersonaTrees.ts";

export type PersonaSchemeInvoke = (
    verb: "list" | "replace" | "remove" | "disable",
    params: unknown,
    identity: { readonly workspaceId: number; readonly sessionId: number },
    caller?: "operation" | "action",
) => Promise<{ readonly status: number; readonly body?: unknown }>;

export class PersonaScheme implements ResourceTreeSource {
    readonly writableBy: readonly WriterTier[] = ["model", "client", "_plurnk"];
    readonly textEditScopes = true;
    readonly refusal: (cause: unknown, address: EntryCoordinate) => RepresentationPreparationResult | null = personaTreeRefusal;
    readonly #trees: (workspaceId: number) => ReadonlyMap<string, ResourceTree>;
    readonly #invoke: PersonaSchemeInvoke;

    constructor(
        personas: { trees(workspaceId: number): ReadonlyMap<string, ResourceTree> },
        invoke: PersonaSchemeInvoke,
    ) {
        this.#trees = (workspaceId) => personas.trees(workspaceId);
        this.#invoke = invoke;
    }

    trees(workspaceId: number): ReadonlyMap<string, ResourceTree> {
        return this.#trees(workspaceId);
    }

    static normalizeAddress(target: ParsedPath, options: { readonly forFind?: boolean } = {}): EntryCoordinate {
        const raw = EntryCoordinates.resolve(target, "resource");
        let { authority, pathname } = raw;
        if (authority.endsWith(".md") && (pathname === "" || pathname === "/")) {
            authority = authority.slice(0, -".md".length);
            pathname = "/PERSONA.md";
        } else if (!options.forFind && authority.length > 0 && !PathSyntax.hasGlob(authority) && (pathname === "" || pathname === "/")) {
            pathname = "/PERSONA.md";
        } else if (authority === "") {
            const mdMatch = /^\/([^/]+)\.md$/u.exec(pathname);
            if (mdMatch !== null) {
                authority = mdMatch[1];
                pathname = "/PERSONA.md";
            } else {
                const subMatch = /^\/([^/]+)(\/.+)$/u.exec(pathname);
                if (subMatch !== null) {
                    authority = subMatch[1];
                    pathname = subMatch[2];
                } else {
                    const bareMatch = /^\/([^/]+)$/u.exec(pathname);
                    if (bareMatch !== null) {
                        authority = bareMatch[1];
                        pathname = options.forFind ? "" : PathSyntax.hasGlob(bareMatch[1]) ? "/" : "/PERSONA.md";
                    } else if (options.forFind && (pathname === "" || pathname === "/")) {
                        authority = "*";
                        pathname = "/";
                    }
                }
            }
        }
        return { authority, pathname };
    }

    normalizeAddress(target: ParsedPath, options?: { readonly forFind?: boolean }): EntryCoordinate {
        return PersonaScheme.normalizeAddress(target, options);
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult> {
        const statement = statements[0];
        if (
            statement === undefined
            || statement.target === null
            || statements.length > 1
            || statement.lineMarker !== null
            || statement.matcher !== null
        ) {
            return SchemeResults.failure(
                "scheme:persona",
                "value-whole",
                400,
                "One edit sets one persona definition, whole.",
                {},
                {
                    recovery: "mcp({ server: \"plurnk\", tool: \"edit\", arguments: { path: \"persona://<name>/PERSONA.md\", text: \"...\" } }) with the complete persona Markdown or JSON definition.",
                    retryable: false,
                },
            );
        }
        const target = statement.target;
        const address = PersonaScheme.normalizeAddress(target);
        if (!SKILL_NAME.test(address.authority) || address.pathname !== "/PERSONA.md") {
            return SchemeResults.failure(
                "scheme:persona",
                "target-invalid",
                400,
                "Persona writes must target persona://<name>/PERSONA.md (or persona://<name>.md) with a valid lowercase-hyphenated persona name.",
                {},
                { target: target.raw, retryable: false },
            );
        }
        let definition: PersonaDefinition;
        try {
            definition = parsePersonaEditBody(address.authority, statement.body ?? "");
        } catch (cause) {
            return SchemeResults.failure(
                "scheme:persona",
                "persona-invalid",
                400,
                cause instanceof Error ? cause.message : String(cause),
                {},
                { target: target.raw, retryable: false },
            );
        }
        try {
            await this.#invoke(
                "replace",
                { alias: address.authority, ...definition },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(address.pathname);
        return { status: 200 };
    }

    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        if (statement.lineMarker !== null || statement.matcher !== null) {
            return SchemeResults.failure(
                "scheme:persona",
                "value-whole",
                400,
                "kill retires the whole persona definition.",
                {},
                { retryable: false },
            );
        }
        const targetRaw = statement.target?.raw ?? "persona://";
        const address = statement.target === null
            ? { authority: "", pathname: "/" }
            : PersonaScheme.normalizeAddress(statement.target);
        if (!SKILL_NAME.test(address.authority) || address.pathname !== "/PERSONA.md") {
            return SchemeResults.failure(
                "scheme:persona",
                "target-invalid",
                400,
                "Persona kill must target persona://<name>/PERSONA.md (or persona://<name>.md).",
                {},
                { target: targetRaw, retryable: false },
            );
        }
        const listed = await this.#invoke(
            "list",
            {},
            { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
            "action",
        );
        const entry = Validator.assertFunctionalityListResult(listed.body).definitions.find(
            (d) => d.alias === address.authority,
        );
        if (entry === undefined || (entry.origin === "service" && entry.state === "disabled")) {
            return SchemeResults.failure(
                "scheme:persona",
                "entry-not-found",
                404,
                `No persona resource exists at persona://${address.authority}/PERSONA.md.`,
                {},
                { target: targetRaw },
            );
        }
        try {
            await this.#invoke(
                entry.origin === "workspace" ? "remove" : "disable",
                { alias: address.authority },
                { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
                "operation",
            );
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) throw cause;
            return { status: problem.status, problem };
        }
        await ctx.entries.delete(address.pathname);
        return { status: 200 };
    }
}
