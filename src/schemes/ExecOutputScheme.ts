import type { FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import type { Executor } from "../core/ExecutorRegistry.ts";
import type Exec from "./Exec.ts";
import EntryOps, { type ReadResult } from "./_entry-ops.ts";
import EntryFind, { type FindResult } from "./_entry-find.ts";
import EntryCrud, { type ReadEntryResult } from "./_entry-crud.ts";

// #240 — an executor IS a scheme; its output lives at <tag>://. Each discovered
// executor registers this face under its runtime tag, so READ/FIND <tag>://<coord>
// read PRIOR output, scoped to the tag's stored entries via the executor's OWN
// manifest (name = the tag) — fixing the latent mis-scope where the shared `exec`
// handler read under scheme="exec" while output persists under scheme=<tag>. The
// face never executes (the run stays on EXEC); process-KILL by coordinate and the
// COPY/MOVE source-read are the only cross-cutting bits — KILL delegates to the one
// Exec handler that owns the spawn-abort state, the source-read is tag-scoped here.
// Every tag — sh, search, sqlite, MCP — reads through this one uniform path; an executor
// is a pure PRODUCER (run() writes channels), never a read/find face (execs#13).
export default class ExecOutputScheme {
    #executor: Executor;
    #exec: Exec;
    constructor(executor: Executor, exec: Exec) {
        this.#executor = executor;
        this.#exec = exec;
    }

    get manifest(): SchemeManifest { return this.#executor.manifest; }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, this.#executor.manifest);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findSessionEntries(statement, ctx, this.#executor.manifest);
    }

    // COPY/MOVE source — read the output entry by pathname, tag-scoped (not via the
    // shared Exec handler, which would scope to scheme="exec" and 404).
    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, this.#executor.manifest.name);
    }

    // Process-KILL by coordinate — the spawn-abort state (#activeAborts) lives on the
    // one Exec handler, so the per-tag face delegates to it.
    async kill(pathname: string, signal: number | null, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        return this.#exec.kill(pathname, signal, ctx);
    }
}
