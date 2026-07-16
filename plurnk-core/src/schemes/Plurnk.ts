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

// Engine-authored reference scheme — the prompt (`plurnk://prompt/<run>/<loop>/<N>`), the scheme
// docs (`plurnk:///docs/*`), the catalog. All of it the engine writes FOR the model to READ;
// none of it is the model's to write. writableBy excludes "model", so the manifest gate
// (§scheme-surface-writableby-403) rejects every model-origin write uniformly — no path special-
// case. The model's scratch surface is `known://`; editing plurnk:// reference used to "succeed"
// and became a scratch-behavior sink for weak models (#310).
export default class Plurnk {
    static manifest: SchemeManifest = {
        name: "plurnk",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["client", "plurnk"],
        volatile: false,
        modelVisible: true,
        example: "<<FIND(plurnk:///**)::FIND",
        documentation: "Engine-authored reference surfaced to you — your active prompt at `plurnk://prompt/<run>/<loop>/<N>` (READ the address the User Prompts section lists), the scheme docs at `plurnk://docs/*`. READ-ONLY: READ these, never EDIT them (use `known://` for your own scratch).",
    };

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        return EntryOps.editWorkspaceEntry(statement, ctx, Plurnk.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readWorkspaceEntry(statement, ctx, Plurnk.manifest);
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
        return EntrySend.sendToWorkspaceEntry(statement, ctx, Plurnk.manifest.name);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findWorkspaceEntries(statement, ctx, Plurnk.manifest);
    }
}
