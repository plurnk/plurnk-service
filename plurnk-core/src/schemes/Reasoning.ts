import type { EntryEditResult, EntryFindResult, FindStatement, ResolvedEditStatement, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";

// {§reasoning-history} — ordinary worker-owned text; provider evidence is separate.
export default class Reasoning implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "reasoning",
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "worker",
        inherit: "snapshot",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
        example: "### READ0 (reasoning:///1/1/1)",
    };

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
