import type { FindStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type { RepresentationPreparationRequest, SchemeCtx, SchemeManifest } from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase, type CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results from "../core/results.ts";
import TerminalResult from "../core/TerminalResult.ts";
import EntryCrud from "./_entry-crud.ts";

export interface LoopResource {
    name: string;
    sequence: number;
    status: number;
    terminal_result: string | null;
    terminated_by: string | null;
}

// {§worker-loop-result}: entries are derived representations; loops own the evidence.
export default class Loop extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "loop", authority: "resource", category: "data", channels: { body: "text/markdown" },
        defaultChannel: "body", writableBy: [], volatile: false, modelVisible: true,
        folderScopes: true, textEditScopes: false,
    };

    static address(row: Pick<LoopResource, "name" | "sequence">): string {
        return `loop://${row.name}/${row.sequence}`;
    }

    static representation(row: LoopResource) {
        const resource = Loop.address(row);
        const result = row.terminal_result === null
            ? Results.failure("scheme:loop", "loop-unfinished", 425, `The execution at ${resource} has not concluded.`, {}, { retryable: false })
            : TerminalResult.parse(row.terminal_result, resource);
        return TerminalResult.representation(result, resource, row.terminated_by);
    }

    async resolveEntryAddress(target: ParsedPath, _ctx: CoreSchemeCallContext, access: "read" | "write" = "read") {
        if (access === "write") return Results.failure("scheme:loop", "loop-immutable", 405, "Loop outcomes are immutable.");
        if (target.kind !== "url" || target.hostname === null || target.hostname.length === 0
            || [target.username, target.password, target.port, target.query].some((value) => value !== null)) {
            return Results.failure("scheme:loop", "coordinate-malformed", 400, "Use loop://<worker>/<sequence>, without userinfo, a port, or a query.");
        }
        return { authority: target.hostname, pathname: target.pathname };
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx) {
        const sequence = Number(request.pathname.slice(1));
        if (!/^\/[1-9]\d*$/.test(request.pathname) || !Number.isSafeInteger(sequence)) {
            return Results.failure("scheme:loop", "coordinate-malformed", 400, "A loop coordinate is a positive safe-integer sequence.");
        }
        const core = this.coreContext(ctx);
        const row = await core.db.loop_resource_read.get<LoopResource>({
            workspace_id: core.workspaceId, name: request.authority, sequence,
        });
        if (row === undefined) return Results.failure("scheme:loop", "loop-not-found", 404, `No loop exists at ${request.target.raw}.`);
        const written = await ctx.entries.write(request.pathname, Loop.representation(row));
        return written.status >= 400 ? written : { status: 200 };
    }

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx) {
        const core = this.coreContext(ctx);
        for (const row of await core.db.loop_resource_candidates.all<LoopResource>({ workspace_id: core.workspaceId })) {
            const written = await EntryCrud.writeEntry({ authority: row.name, pathname: `/${row.sequence}` }, Loop.representation(row), core, "loop");
            if (written.status >= 400) return written;
        }
        return { status: 200 };
    }
}
