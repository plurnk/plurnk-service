import type { FindStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";

// A third-party namespace using the public entry capabilities, without a core adapter.
export default class EntryScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "fixture", authority: "namespace", category: "data",
        channels: { body: "text/plain" }, defaultChannel: "body", entryOwner: "commons", inherit: "none",
        writableBy: ["model", "client", "plugin", "_plurnk"],
        folderScopes: true, volatile: false, modelVisible: true,
    };

    edit(statement: ResolvedEditStatement, ctx: SchemeCtx) {
        return ctx.entries.operations.editBatch([statement]);
    }

    editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx) {
        return ctx.entries.operations.editBatch(statements);
    }

    find(statement: FindStatement, ctx: SchemeCtx) {
        return ctx.entries.operations.find(statement);
    }
}
