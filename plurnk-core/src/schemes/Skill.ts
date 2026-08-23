// PROVISIONAL: this handler delegates to the shared entry operation surface,
// but its scheme-specific semantics are not yet designed. It is a generic
// model-writable data scheme, NOT the Agent Skills feature — that surface is
// worker://~/skills/ ({§skills-materialization}). Its future (rename or
// retirement) is a separate design ruling.

import type { EntryEditResult, EntryFindResult, ResolvedEditStatement, SchemeCtx, SchemeHandler, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import type { FindStatement, SendStatement } from "@plurnk/plurnk-contracts";
import LineAnchors from "../content/line-anchors.ts";

export default class Skill implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "skill",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "worker",
        inherit: "snapshot",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
    };

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        LineAnchors.assertResolved(statements);
        return ctx.entries.operations.editBatch(statements);
    }

    async edit(statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<EntryEditResult> {
        return this.editBatch([statement], ctx);
    }

    async send(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.operations.send(statement);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
