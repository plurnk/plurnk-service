import type { FindStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../core/scheme-types.ts";
import type { Executor } from "../core/ExecutorRegistry.ts";
import type Exec from "./Exec.ts";
import { resolveStreamStatement } from "./Exec.ts";
import EntryOps, { type ReadResult } from "./_entry-ops.ts";
import EntryFind, { type FindResult } from "./_entry-find.ts";
import EntryCrud, { type ReadEntryResult } from "./_entry-crud.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import type { SchemeCtx } from "@plurnk/plurnk-schemes";

// #240 — an executor IS a scheme; its output lives at <tag>://. Each discovered
// executor registers this face under its runtime tag, so READ/FIND <tag>://<coord>
// read PRIOR output, scoped to the tag's stored entries via the executor's OWN
// manifest (name = the tag) — fixing the latent mis-scope where the shared `exec`
// handler read under scheme="exec" while output persists under scheme=<tag>. The
// face never executes (the worker stays on EXEC); process-KILL by coordinate and the
// COPY/MOVE source-read are the only cross-cutting bits — KILL delegates to the one
// Exec handler that owns the spawn-abort state, the source-read is tag-scoped here.
// Every tag — sh, search, sqlite, MCP — reads through this one uniform path; an executor
// is a pure PRODUCER (run() writes channels), never a read/find face (execs#13).
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

    #claimedPath(statement: ReadStatement | FindStatement): boolean {
        const target = statement.target;
        return target?.kind === "url" && this.#facet?.claims(target.pathname ?? "") === true;
    }

    #facetContext(ctx: CoreSchemeCallContext): SchemeCtx {
        if ("entries" in ctx) return ctx;
        return new SchemeCtxImpl(
            ctx,
            this.#executor.manifest.name,
            this.#executor.manifest,
            this.liveSubscriptions(),
        );
    }

    // {§stream-owner-scoped} — the authority names the OWNER: empty = the calling worker (your
    // own streams need no qualifier), a name = that worker's streams, ancestry-gated. The
    // resolved owner scopes the identity; the storage path stays the bare loop coordinate.
    async read(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<ReadResult> {
        const read = this.#facet?.read;
        if (read !== undefined && this.#claimedPath(statement)) {
            return await read.call(this.#facet, statement, this.#facetContext(ctx)) as ReadResult;
        }
        const core = this.coreContext(ctx);
        const owner = await resolveStreamStatement(statement, core);
        if (owner === null) {
            return Results.failure(`scheme:${this.#executor.manifest.name}`, "stream-not-found", 404, "No visible stream exists at the requested address.", {
                content: null, mimetype: null, channel: null,
            }) as ReadResult;
        }
        return EntryOps.readWorkspaceEntry(owner.statement, core, this.#executor.manifest, owner.ownerId);
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
                content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [],
            }) as FindResult;
        }
        return EntryFind.findWorkspaceEntries(owner.statement, core, this.#executor.manifest, owner.ownerId);
    }

    // COPY/MOVE source — read the output entry by pathname, tag-scoped (not via the
    // shared Exec handler, which would scope to scheme="exec" and 404). Self-owned:
    // a worker copies from its own streams.
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return EntryCrud.readEntry(pathname, core, this.#executor.manifest.name, core.workerId);
    }

    // Process-KILL by coordinate — the spawn-abort state (#activeAborts) lives on the
    // one Exec handler, so the per-tag face delegates to it.
    async kill(pathname: string, signal: number | null, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        return this.#exec.kill(pathname, signal, ctx);
    }
}
