// PROVISIONAL: this scheme handler exists structurally (parallel to Known/
// Unknown) but its semantics are NOT yet designed.

import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EditStatement, FindStatement, ReadStatement, SendStatement } from "@plurnk/plurnk-grammar";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import EntryFind from "./_entry-find.ts";
import type { EditResult, ReadResult } from "./_entry-ops.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { SendResult } from "./_entry-send.ts";
import type { FindResult } from "./_entry-find.ts";

export default class Skill {
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

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        return EntryOps.editWorkspaceEntry(statement, ctx, Skill.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readWorkspaceEntry(statement, ctx, Skill.manifest);
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

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult> {
        return EntrySend.sendToWorkspaceEntry(statement, ctx, Skill.manifest.name);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findWorkspaceEntries(statement, ctx, Skill.manifest);
    }
}
