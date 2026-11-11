// {§persona-discovery} — `persona://` resource-tree scheme (`READ`, `FIND`, `EDIT`, `KILL`).
import {
    PathSyntax,
    Problems,
    SKILL_NAME,
    Validator,
    type FindStatement,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import {
    Results as SchemeResults,
    type EditBatchResult,
    type EntryAddress,
    type EntryCoordinate,
    type ResolvedEditStatement,
    type SchemeAddressCtx,
    type SchemeCtx,
    type SchemeManifest,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import { entryCoordinateOf } from "../core/plurnk-uri.ts";
import type { FindResult } from "../schemes/_entry-find.ts";
import ResourceTreeScheme from "../schemes/ResourceTreeScheme.ts";
import { parsePersonaEditBody, type PersonaDefinition } from "./PersonaDefinition.ts";
import { personaTreeRefusal } from "./PersonaTrees.ts";
import type WorkspacePersonas from "./WorkspacePersonas.ts";

export type PersonaSchemeInvoke = (
    verb: "list" | "replace" | "remove" | "disable",
    params: unknown,
    identity: { readonly workspaceId: number; readonly sessionId: number },
    caller?: "operation" | "action",
) => Promise<{ readonly status: number; readonly body?: unknown }>;

export class PersonaScheme extends ResourceTreeScheme {
    override readonly manifest: SchemeManifest = {
        name: "persona",
        authority: "resource",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        folderScopes: true,
        textEditScopes: true,
        modelVisible: true,
    };

    readonly #personas: WorkspacePersonas;
    readonly #invoke: PersonaSchemeInvoke;

    constructor(personas: WorkspacePersonas, invoke: PersonaSchemeInvoke) {
        super("persona", {
            trees: (workspaceId) => personas.trees(workspaceId),
            refusal: personaTreeRefusal,
        });
        this.#personas = personas;
        this.#invoke = invoke;
    }

    static normalizeAddress(target: ParsedPath, options: { readonly forFind?: boolean } = {}): EntryCoordinate {
        const raw = entryCoordinateOf(target, "resource");
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

    override async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        if (statement.target?.kind === "url") {
            const normalized = PersonaScheme.normalizeAddress(statement.target, { forFind: true });
            return await super.find(
                {
                    ...statement,
                    target: {
                        ...statement.target,
                        hostname: normalized.authority,
                        port: null,
                        pathname: PathSyntax.encodeParens(normalized.pathname),
                        query: null,
                    },
                },
                ctx,
            );
        }
        return await super.find(statement, ctx);
    }

    override async resolveEntryAddress(
        target: ParsedPath,
        ctx: SchemeAddressCtx,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | null> {
        const address = PersonaScheme.normalizeAddress(target);
        if (access === "write") return address;
        const trees = this.#personas.trees(ctx.workspaceId);
        return PathSyntax.hasGlob(address.authority) || trees.has(address.authority) ? address : null;
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
                    recovery: "plurnk.edit({ path: \"persona://<name>/PERSONA.md\", content: \"...\" }) with the complete persona Markdown or JSON definition.",
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
