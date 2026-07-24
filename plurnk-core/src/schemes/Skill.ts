// PROVISIONAL: this scheme handler exists structurally (parallel to Known/
// Unknown) but its semantics are NOT yet designed.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EntryEditResult, EntryFindResult, EntryReadResult, SchemeCtx, SchemeHandler, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import type { EditStatement, FindStatement, ReadStatement, SendStatement } from "@plurnk/plurnk-grammar";
import EntryCrud from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";

export default class Skill implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "skill",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
    };

    async edit(statement: EditStatement, ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.edit(statement);
    }

    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<EntryReadResult> {
        return ctx.entries.operations.read(statement);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, Skill.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, ctx, Skill.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, ctx, Skill.manifest.name);
    }

    async send(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.operations.send(statement);
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement);
    }
}
