import type { EntryEditResult, EntryFindResult, ResolvedEditStatement, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import type { FindStatement } from "@plurnk/plurnk-contracts";
import LineAnchors from "../content/line-anchors.ts";

// {§prompt-address}: immutable-to-model task frames at literal workspace addresses.
export default class Prompt implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prompt",
        authority: "resource",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["client", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
    };

    // The actionless prompt log row is written separately from its source entry.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        LineAnchors.assertResolved(statements);
        return ctx.entries.operations.editBatch(statements);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
