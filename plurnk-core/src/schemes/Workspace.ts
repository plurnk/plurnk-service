import type { SchemeManifest } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import type { SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type {
    EntryAddress,
    ResolvedEditStatement,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";

// {§session-scheme} Shared workspace commons and generated reference entries live under workspace:///.
export default class Workspace extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "workspace",
        authority: "namespace",
        // {§channel-selection} — `readable` is the source's derived projection, never written.
        channels: { readable: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
    };

    static #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "workspace") return null;
        return target.hostname ?? "";
    }

    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    static #entryAddress(authority: string, pathname: string, access: "read" | "write"): EntryAddress | SchemeResultBase {
        if (authority !== "") return Results.failure(
            "scheme:workspace", "workspace-authority-unsupported", 400,
            "A workspace:/// address takes no authority.", {},
            { recovery: "Use workspace:///path for shared workspace entries or session://<name>/path for session scratch.", retryable: false },
        );
        if (access === "write" && pathname === "") return Results.failure(
            "scheme:workspace", "workspace-entity-not-editable", 400,
            "A workspace entity is not an editable entry.", {},
            { recovery: "EDIT requires an entry path, such as workspace:///example.md.", retryable: false },
        );
        return { authority: "", pathname };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: CoreSchemeCallContext,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | SchemeResultBase | null> {
        const authority = Workspace.#authority(target);
        return authority === null ? null
            : Workspace.#entryAddress(authority, Workspace.#entryPath(target), access);
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        _ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.metadata !== null) {
            return Results.failure(
                "scheme:workspace",
                "metadata-unsupported",
                400,
                "Workspace resource reads do not accept the [metadata] modifier.",
                {},
                { retryable: false },
            );
        }
        return { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
        const precondition = SchemeCtxImpl.editPreconditionOf(ctx);
        const failure = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): EditResult => Results.failure(
            "scheme:workspace",
            code,
            status,
            detail,
            { entryId: null, channel: null },
            extensions,
        );
        const statement = statements[0];
        if (statement === undefined) {
            return failure(
                "edit-empty",
                400,
                "EDIT requires at least one statement.",
                {
                    recovery: "Add an EDIT statement or omit the operation.",
                    retryable: false,
                },
            );
        }
        const core = this.coreContext(ctx);
        const authority = Workspace.#authority(statement.target);
        if (authority === null) {
            return failure(
                "workspace-target-required",
                400,
                "EDIT requires a workspace:/// target.",
                {
                    recovery: "Provide the workspace target.",
                    retryable: false,
                },
            );
        }
        const entryPath = Workspace.#entryPath(statement.target);
        const resolved = Workspace.#entryAddress(authority, entryPath, "write");
        if ("status" in resolved) return { ...resolved, entryId: null, channel: null };
        if (statements.some((candidate) => Workspace.#authority(candidate.target) !== "")) {
            return failure(
                "edit-batch-mismatch",
                400,
                "One EDIT batch cannot span multiple spaces.",
                {
                    recovery: "Use a separate EDIT batch for each space.",
                    retryable: false,
                },
            );
        }
        return EntryOps.editWorkspaceEntryBatch(
            statements,
            core,
            Workspace.manifest,
            precondition,
        );
    }

    async edit(statement: ResolvedEditStatement, ctx: CoreSchemeCallContext): Promise<EditResult> {
        return this.editBatch([statement], ctx);
    }

    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Workspace.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:workspace",
                "workspace-target-required",
                400,
                "KILL requires a workspace target.",
                {},
                {
                    recovery: "Provide the workspace target.",
                    retryable: false,
                },
            );
        }
        const resolved = Workspace.#entryAddress(authority, Workspace.#entryPath(statement.target), "write");
        if ("status" in resolved) return resolved;
        return EntryOps.deleteWorkspaceEntry(statement, core, Workspace.manifest);
    }

    // {§session-scheme} The requested namespace scopes discovery, not access.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = Workspace.#authority(statement.target);
        if (authority === null) {
            return Results.failure("scheme:workspace", "workspace-target-required", 400, "FIND requires a workspace:/// target.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Provide the workspace target.",
                retryable: false,
            });
        }
        if (authority !== "") {
            return Results.failure("scheme:workspace", "workspace-authority-unsupported", 400, "A workspace:/// address takes no authority.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Use workspace:///path for shared workspace entries or session://<name>/path for session scratch.",
                retryable: false,
            });
        }
        // {§question-tool} The shared reserved tree, as this session may see it.
        const visible = await core.referenceVisibility?.();
        return EntryFind.findWorkspaceEntries(statement, core, Workspace.manifest, { authority: "", ...(visible === undefined ? {} : { visible }) });
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, Workspace.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry(
                { authority: "", pathname },
                entry,
                this.coreContext(ctx),
                Workspace.manifest.name,
            );
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry(
                { authority: "", pathname },
                this.coreContext(ctx),
                Workspace.manifest.name,
            );
    }

    async send(statement: SendStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Workspace.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:workspace",
                "workspace-target-required",
                400,
                "Directed workspace SEND requires a workspace target.",
                {},
                {
                    recovery: "Provide the workspace target.",
                    retryable: false,
                },
            );
        }
        if (authority !== "") {
            return Results.failure(
                "scheme:workspace",
                "workspace-authority-unsupported",
                400,
                "A workspace:/// address takes no authority.",
                {},
                {
                    recovery: "Use workspace:///path for shared workspace entries or session://<name>/path for session scratch.",
                    retryable: false,
                },
            );
        }
        return EntrySend.sendToWorkspaceEntry(statement, core, Workspace.manifest);
    }
}
