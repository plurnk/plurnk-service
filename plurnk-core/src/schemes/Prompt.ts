import type { EntryEditResult, EntryFindResult, ResolvedEditStatement, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import type { FindStatement } from "@plurnk/plurnk-contracts";
import LineAnchors from "../content/line-anchors.ts";

// {§prompt-self-only} — prompt:// carries the worker's own task frames: each loop's prompt at
// prompt:///<loopSeq>/<turnSeq>, owned by the worker via owner_id — the address carries only the
// loop coordinate, so no worker identity ever rides a pathname or a packet. SELF-ONLY by
// construction: packets are per-worker and every cross-worker prompt flow (parent→child inject,
// the drain's orphan promotion) is engine-mediated, so the face takes no authority slot — a
// worker only ever addresses its own frames. Engine-authored (writableBy excludes the model);
// prompt-target log rows remain ordinary curatable memory.
export default class Prompt implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prompt",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "worker",
        inherit: "snapshot",
        writableBy: ["client", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
        example: "## READ0 (prompt:///1/1)",
    };

    // Engine and client prompt writers persist the frame owner-keyed to the
    // worker it addresses. The actionless prompt log row is written separately.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        LineAnchors.assertResolved(statements);
        return ctx.entries.operations.editBatch(statements);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
