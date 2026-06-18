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
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";

// Internal-events scheme. Indexed entries the engine writes for the model
// to see — currently just prompts at `plurnk:///prompt/<loop_id>`. Future
// internal model-interactions land here as their need arises.
//
// writableBy is open at the manifest level so future plurnk:///… paths can
// accept any origin. Path-prefix restrictions live in the edit handler:
// `plurnk:///prompt/*` rejects model-origin writes (engine/client own those).
export default class Plurnk {
    static teach = "Engine-authored events surfaced to you — most notably your active prompt at `plurnk://prompt/<loop>`. You may READ these and EDIT your own `plurnk://` notes, but `plurnk://prompt/*` is engine-owned and rejects your writes.";

    static manifest: SchemeManifest = {
        name: "plurnk",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plurnk"],
        volatile: false,
        modelVisible: true,
    };

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        const t = statement.target;
        // Fold authority→path (plurnk://prompt/<loop> ⇒ /prompt/<loop>) so the engine-owned
        // prompt namespace stays protected regardless of the addressing form the model used.
        const pathname = t !== null && t.kind === "url"
            ? foldAuthorityIntoPath(t.hostname, t.pathname)
            : t?.raw ?? "";
        if (ctx.writer === "model" && pathname.startsWith("/prompt/")) {
            return { status: 403, entryId: null, channel: null };
        }
        return EntryOps.editSessionEntry(statement, ctx, Plurnk.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, Plurnk.manifest);
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
