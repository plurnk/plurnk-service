import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EditStatement, FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryFind from "./_entry-find.ts";
import type { EditResult, ReadResult } from "./_entry-ops.ts";
import type { ReadEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";

// prompt:// — the worker's own task frames ({§prompt-self-only}, #527): each loop's prompt at
// prompt:///<loopSeq>/<turnSeq>, owned by the worker via owner_id — the address carries only the
// loop coordinate, so no worker identity ever rides a pathname or a packet. SELF-ONLY by
// construction: packets are per-worker and every cross-worker prompt flow (parent→child inject,
// the drain's orphan promotion) is engine-mediated, so the face takes no authority slot — a
// worker only ever addresses its own frames. Engine-authored (writableBy excludes the model);
// FOLD of the current loop's preview READ stays illegal (§prompt-fold-illegal), KILL stays the
// deliberate remove; every other prompt-target log row is ordinary curatable memory.
export default class Prompt {
    static manifest: SchemeManifest = {
        name: "prompt",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["client", "plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        example: "<<READ(prompt:///1/1)::READ",
        documentation: "Your task frames — each loop's prompt at `prompt:///<loop>/<N>` (READ the address the User Prompts section lists). READ-ONLY: the engine writes these for you; your scratch lives at `worker://~/` and the shared blackboard at `worker:///`.",
    };

    // The engine's foisted prompt EDIT (origin plurnk; the model is gated off by writableBy) —
    // the frame lands owner-keyed to the worker it addresses.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        return EntryOps.editWorkspaceEntry(statement, ctx, Prompt.manifest, ctx.workerId);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readWorkspaceEntry(statement, ctx, Prompt.manifest, ctx.workerId);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findWorkspaceEntries(statement, ctx, Prompt.manifest, ctx.workerId);
    }

    // COPY source / engine readers — the caller's own frame.
    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, Prompt.manifest.name, ctx.workerId);
    }
}
