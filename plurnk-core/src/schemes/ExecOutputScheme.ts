import type { FindStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../core/scheme-types.ts";
import type { Executor } from "../core/ExecutorRegistry.ts";
import type Exec from "./Exec.ts";
import { resolveStreamStatement } from "./Exec.ts";
import EntryFind, { type FindResult } from "./_entry-find.ts";
import EntryCrud, { type ReadEntryResult } from "./_entry-crud.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreEntryAddress, CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import type {
    EntryAddress,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import Owner from "../core/Owner.ts";
import { renderAddress } from "../core/plurnk-uri.ts";

// {§stream-owner-scoped} — a stream 404 discloses nothing about existence; it may still say what
// the address space IS: loop coordinates, the caller's own streams unqualified, a descendant's by
// worker name, and a tool's own ids as arguments rather than addresses (#392).
const streamAddressSpace = (scheme: string): string =>
    `\`${scheme}:///<loop>/<turn>/<item>\` addresses this runtime's result streams — your own without a qualifier, another worker's as \`${scheme}://<worker>/…\`. A tool's own ids are arguments: \`## EXEC0 [${scheme}] (<tool>)\` with the id in the body.`;

// {§executor-scheme-output} An executor is a scheme; its output lives at <tag>://. Each discovered
// executor registers this face under its runtime tag, so READ/FIND <tag>://<coord>
// read PRIOR output, scoped to the tag's stored entries via the executor's OWN
// manifest (name = the tag) — fixing the latent mis-scope where the shared `exec`
// handler read under scheme="exec" while output persists under scheme=<tag>. The
// face never executes (the worker stays on EXEC); process-KILL by coordinate and the
// COPY/MOVE source-read are the only cross-cutting bits — KILL delegates to the one
// Exec handler that owns the spawn-abort state, the source-read is tag-scoped here.
// Every tag reads through this one uniform path; an executor is a pure producer
// whose run() writes channels, never a read/find face.
export default class ExecOutputScheme extends CoreSchemeAdapterBase {
    #executor: Executor;
    #exec: Exec;
    #facet: RuntimeSchemeFacet | undefined;

    constructor(executor: Executor, exec: Exec, facet?: RuntimeSchemeFacet) {
        super();
        this.#executor = executor;
        this.#exec = exec;
        this.#facet = facet;
    }

    get manifest(): SchemeManifest {
        return this.#executor.manifest;
    }

    #claimedPath(statement: FindStatement): boolean {
        const target = statement.target;
        return target?.kind === "url" && this.#facet?.claims(target.pathname ?? "") === true;
    }

    #facetContext(ctx: CoreSchemeCallContext): SchemeCtx {
        if ("entries" in ctx) return ctx;
        const core = this.coreContext(ctx);
        return new SchemeCtxImpl(
            core,
            this.#executor.manifest.name,
            this.#executor.manifest,
            this.liveSubscriptions(),
            { ownerId: core.workerId },
        );
    }

    async resolveEntryAddress(
        target: ParsedPath,
        ctx: CoreSchemeCallContext,
    ): Promise<EntryAddress | CoreEntryAddress | SchemeResultBase | null> {
        if (target.kind !== "url") return null;
        if (this.#facet?.claims(target.pathname) === true) {
            return { authority: "", pathname: target.pathname, owner: "worker" };
        }
        const core = this.coreContext(ctx);
        const name = this.#executor.manifest.name;
        const ownerId = await Owner.resolveStreamOwner(target.hostname, core);
        if (ownerId === null) {
            return Results.failure(
                `scheme:${name}`,
                "stream-not-found",
                404,
                "No visible stream exists at the requested address.",
                {},
                { target: target.raw, recovery: streamAddressSpace(name), retryable: false },
            );
        }
        const scheme = EntryCrud.identityScheme(this.#executor.manifest);
        const existing = await core.db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: core.workspaceId, owner_id: ownerId, scheme, authority: "", pathname: target.pathname,
        });
        if (existing === undefined) {
            const address = renderAddress({ scheme: name, authority: target.hostname ?? "", pathname: target.pathname });
            return Results.failure(
                `scheme:${name}`,
                "entry-not-found",
                404,
                `No entry exists at ${address}.`,
                {},
                { target: address, recovery: streamAddressSpace(name), retryable: false },
            );
        }
        return { authority: "", pathname: target.pathname, ownerId };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: CoreSchemeCallContext,
    ): Promise<RepresentationPreparationResult> {
        if (this.#facet?.claims(request.pathname) !== true) return { status: 200 };
        return this.#facet.prepareRepresentation?.(request, this.#facetContext(ctx)) ?? { status: 200 };
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const find = this.#facet?.find;
        if (find !== undefined && this.#claimedPath(statement)) {
            return await find.call(this.#facet, statement, this.#facetContext(ctx)) as FindResult;
        }
        const core = this.coreContext(ctx);
        const owner = await resolveStreamStatement(statement, core);
        if (owner === null) {
            return Results.failure(`scheme:${this.#executor.manifest.name}`, "stream-not-found", 404, "No visible stream exists at the requested address.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, { recovery: streamAddressSpace(this.#executor.manifest.name), retryable: false }) as FindResult;
        }
        return EntryFind.findWorkspaceEntries(owner.statement, core, this.#executor.manifest, {
            ownerId: owner.ownerId,
        });
    }

    // COPY/MOVE source — read the output entry by pathname, tag-scoped (not via the
    // shared Exec handler, which would scope to scheme="exec" and 404). Self-owned:
    // a worker copies from its own streams.
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return EntryCrud.readEntry({ authority: "", pathname }, core, this.#executor.manifest.name, core.workerId);
    }

    // Process-KILL by coordinate — the spawn-abort state (#activeAborts) lives on the
    // one Exec handler, so the per-tag face delegates to it.
    async kill(pathname: string, signal: number | null, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        // The face names its own tag: the terminal status of a finished stream lives under the
        // runtime scheme (`sh:///…`), so a second KILL answers 410, never a 404 under `exec`.
        return this.#exec.kill(pathname, signal, ctx, this.#executor.manifest.name);
    }
}
