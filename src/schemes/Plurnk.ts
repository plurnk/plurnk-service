import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import EntryFind from "./_entry-find.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { SendResult } from "./_entry-send.ts";
import type { FindResult } from "./_entry-find.ts";

// Internal-events scheme. Indexed entries the engine writes for the model
// to see — currently just prompts at `plurnk://prompt/<loop_id>`. Future
// internal model-interactions land here as their need arises.
//
// writableBy is open at the manifest level so future plurnk://… paths can
// accept any origin. Path-prefix restrictions live in the edit handler:
// `plurnk://prompt/*` rejects model-origin writes (engine/client own those).
export default class Plurnk {
    static manifest: SchemeManifest = {
        name: "plurnk",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "system"],
        volatile: false,
        modelVisible: true,
    };

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        const pathname = statement.target !== null && statement.target.kind === "url"
            ? statement.target.pathname
            : statement.target?.raw ?? "";
        if (ctx.writer === "model" && pathname.startsWith("prompt/")) {
            return { status: 403, entryId: null, channel: null };
        }
        return EntryOps.editSessionEntry(statement, ctx, Plurnk.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, Plurnk.manifest);
    }

    async show(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return EntryOps.showSessionEntry(statement, ctx, Plurnk.manifest);
    }

    async hide(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return EntryOps.hideSessionEntry(statement, ctx, Plurnk.manifest);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, Plurnk.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, ctx, Plurnk.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, ctx, Plurnk.manifest.name);
    }

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult> {
        return EntrySend.sendToSessionEntry(statement, ctx, Plurnk.manifest.name);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findSessionEntries(statement, ctx, Plurnk.manifest);
    }
}
