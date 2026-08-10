// PROVISIONAL: this handler delegates to the shared entry operation surface,
// but its scheme-specific semantics are not yet designed.

import type { EntryEditResult, EntryFindResult, SchemeCtx, SchemeHandler, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import type { EditStatement, FindStatement, SendStatement } from "@plurnk/plurnk-contracts";

export default class Skill implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "skill",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
    };

    async editBatch(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements);
    }

    async edit(statement: EditStatement, ctx: SchemeCtx): Promise<EntryEditResult> {
        return this.editBatch([statement], ctx);
    }

    async send(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.operations.send(statement);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
