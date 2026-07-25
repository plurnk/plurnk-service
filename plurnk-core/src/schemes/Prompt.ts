import type { EntryEditResult, EntryFindResult, EntryReadResult, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import type { EditStatement, FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";

// prompt:// — the worker's own task frames ({§prompt-self-only}, #527): each loop's prompt at
// prompt:///<loopSeq>/<turnSeq>, owned by the worker via owner_id — the address carries only the
// loop coordinate, so no worker identity ever rides a pathname or a packet. SELF-ONLY by
// construction: packets are per-worker and every cross-worker prompt flow (parent→child inject,
// the drain's orphan promotion) is engine-mediated, so the face takes no authority slot — a
// worker only ever addresses its own frames. Engine-authored (writableBy excludes the model);
// FOLD of the current loop's preview READ stays illegal (§prompt-fold-illegal), KILL stays the
// deliberate remove; every other prompt-target log row is ordinary curatable memory.
export default class Prompt implements SchemeHandler {
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
    async edit(statement: EditStatement, ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.edit(statement, "worker");
    }

    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<EntryReadResult> {
        return ctx.entries.operations.read(statement, "worker");
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement, "worker");
    }
}
