import type { SchemeManifest } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import type { FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
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

// {§tools-resource-materialization} Reference entries and consolidated global guidance live under plurnk:/// and mcp:///.
export default class Plurnk extends CoreSchemeAdapterBase {
    readonly #manifest: SchemeManifest;

    constructor(name: "plurnk" | "mcp" = "plurnk") {
        super();
        this.#manifest = {
            name,
            authority: "namespace",
            channels: { readable: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["_plurnk"],
            volatile: false,
            modelVisible: true,
            folderScopes: true,
            textEditScopes: true,
        };
    }

    get manifest(): SchemeManifest {
        return this.#manifest;
    }

    #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== this.#manifest.name) return null;
        return target.hostname ?? "";
    }

    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    #entryAddress(authority: string, pathname: string, access: "read" | "write"): EntryAddress | SchemeResultBase {
        if (authority !== "") return Results.failure(
            `scheme:${this.#manifest.name}`, `${this.#manifest.name}-authority-unsupported`, 400,
            `A ${this.#manifest.name}:/// address takes no authority.`, {},
            { recovery: `Use ${this.#manifest.name}:///path.`, retryable: false },
        );
        if (access === "write" && pathname === "") return Results.failure(
            `scheme:${this.#manifest.name}`, `${this.#manifest.name}-entity-not-editable`, 400,
            `A ${this.#manifest.name} entity is not an editable entry.`, {},
            { recovery: `EDIT requires an entry path, such as ${this.#manifest.name}:///example.md.`, retryable: false },
        );
        return { authority: "", pathname };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: CoreSchemeCallContext,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | SchemeResultBase | null> {
        const authority = this.#authority(target);
        return authority === null ? null
            : this.#entryAddress(authority, Plurnk.#entryPath(target), access);
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        _ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.metadata !== null) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                "metadata-unsupported",
                400,
                `Resource reads on '${this.#manifest.name}' do not accept the [metadata] modifier.`,
                {},
                { retryable: false },
            );
        }
        return { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
        const precondition = SchemeCtxImpl.editPreconditionOf(ctx);
        const statement = statements[0];
        if (statement === undefined) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                "edit-empty",
                400,
                "EDIT requires at least one statement.",
                { entryId: null, channel: null },
                { recovery: "Add an EDIT statement or omit the operation.", retryable: false },
            );
        }
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                `${this.#manifest.name}-target-required`,
                400,
                `EDIT requires a ${this.#manifest.name}:/// target.`,
                { entryId: null, channel: null },
                { recovery: `Provide the ${this.#manifest.name} target.`, retryable: false },
            );
        }
        const entryPath = Plurnk.#entryPath(statement.target);
        const resolved = this.#entryAddress(authority, entryPath, "write");
        if ("status" in resolved) return { ...resolved, entryId: null, channel: null };
        return EntryOps.editWorkspaceEntryBatch(
            statements,
            core,
            this.#manifest,
            precondition,
        );
    }

    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                `${this.#manifest.name}-target-required`,
                400,
                `KILL requires a ${this.#manifest.name} target.`,
                {},
                { recovery: `Provide the ${this.#manifest.name} target.`, retryable: false },
            );
        }
        const resolved = this.#entryAddress(authority, Plurnk.#entryPath(statement.target), "write");
        if ("status" in resolved) return resolved;
        return EntryOps.deleteWorkspaceEntry(statement, core, this.#manifest);
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(`scheme:${this.#manifest.name}`, `${this.#manifest.name}-target-required`, 400, `FIND requires a ${this.#manifest.name}:/// target.`, {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: `Provide the ${this.#manifest.name} target.`,
                retryable: false,
            });
        }
        if (authority !== "") {
            return Results.failure(`scheme:${this.#manifest.name}`, `${this.#manifest.name}-authority-unsupported`, 400, `A ${this.#manifest.name}:/// address takes no authority.`, {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: `Use ${this.#manifest.name}:///path.`,
                retryable: false,
            });
        }
        const visible = await core.referenceVisibility?.();
        return EntryFind.findWorkspaceEntries(statement, core, this.#manifest, { authority: "", ...(visible === undefined ? {} : { visible }) });
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, this.#manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry(
                { authority: "", pathname },
                entry,
                this.coreContext(ctx),
                this.#manifest.name,
            );
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry(
                { authority: "", pathname },
                this.coreContext(ctx),
                this.#manifest.name,
            );
    }
}
