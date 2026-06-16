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

export default class Known {
    // A scheme declares its manifest — channels, default channel, scope, writableBy. §scheme-manifest-manifest
    static manifest: SchemeManifest = {
        name: "known",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        return EntryOps.editSessionEntry(statement, ctx, Known.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, Known.manifest);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, Known.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, ctx, Known.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, ctx, Known.manifest.name);
    }

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult> {
        return EntrySend.sendToSessionEntry(statement, ctx, Known.manifest.name);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findSessionEntries(statement, ctx, Known.manifest);
    }
}
