import type { FindStatement, KillStatement, ParsedPath, SendStatement } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../core/scheme-types.ts";
import type Exec from "./Exec.ts";
import EntryFind, { type FindResult } from "./_entry-find.ts";
import EntryCrud, { type ReadEntryResult } from "./_entry-crud.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import type {
    EntryAddress,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    ProposalApplyRequest,
    SchemeHandler,
} from "@plurnk/plurnk-schemes";
import { entryCoordinateOf } from "../core/plurnk-uri.ts";

// {§runtime-resource-binding} Stored output and live runtime facets use one entry face.
export default class ExecOutputScheme extends CoreSchemeAdapterBase implements Pick<SchemeHandler, "kill"> {
    #manifest: SchemeManifest;
    #exec: Exec;
    #facet: RuntimeSchemeFacet | undefined;

    constructor(manifest: SchemeManifest, exec: Exec, facet?: RuntimeSchemeFacet) {
        super();
        this.#manifest = manifest;
        this.#exec = exec;
        this.#facet = facet;
    }

    get manifest(): SchemeManifest {
        return { ...this.#manifest, metadataModifier: true };
    }

    #claimedPath(statement: FindStatement): boolean {
        const target = statement.target;
        return target?.kind === "url" && this.#facet?.claims(target.pathname ?? "") === true;
    }

    async #facetContext(ctx: CoreSchemeCallContext): Promise<SchemeCtx> {
        if ("entries" in ctx) return ctx;
        const core = this.coreContext(ctx);
        return new SchemeCtxImpl(
            core,
            this.#manifest.name,
            this.manifest,
            this.liveSubscriptions(),
            { },
        );
    }

    claimsLiveResource(target: ParsedPath): boolean {
        return target.kind === "url" && this.#facet?.claims(target.pathname) === true;
    }

    resolveEntryAddress(target: ParsedPath): EntryAddress | null {
        return target.kind === "url" ? entryCoordinateOf(target, "namespace") : null;
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: CoreSchemeCallContext,
    ): Promise<RepresentationPreparationResult> {
        if (this.#facet?.claims(request.pathname) !== true) {
            if (request.metadata !== null) return Results.failure("scheme:exec", "metadata-unsupported", 400,
                "Stored execution output does not accept READ metadata.", {}, { retryable: false });
            return { status: 200 };
        }
        return this.#facet.prepareRepresentation?.(request, await this.#facetContext(ctx)) ?? { status: 200 };
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const find = this.#facet?.find;
        if (find !== undefined && this.#claimedPath(statement)) {
            return await find.call(this.#facet, statement, await this.#facetContext(ctx)) as FindResult;
        }
        if (statement.metadata !== null) return Results.failure("scheme:exec", "metadata-unsupported", 400,
            "Stored execution output does not accept FIND metadata.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, { retryable: false }) as FindResult;
        const core = this.coreContext(ctx);
        return EntryFind.findWorkspaceEntries(statement, core, this.manifest, {});
    }

    send(statement: SendStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        return this.#exec.sendInput(statement, ctx, this.#manifest.name);
    }

    applyResolution(request: ProposalApplyRequest, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        return this.#exec.applyInput(request, ctx, this.#manifest.name);
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, this.#manifest.name);
    }

    // {§scheme-operation-dispatch} The authored runtime address survives delegation.
    async kill(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        return this.#exec.kill(statement, ctx);
    }
}
