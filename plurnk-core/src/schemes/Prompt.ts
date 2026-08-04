import type { EntryAddress, EntryEditResult, EntryFindResult, EntryReadResult, SchemeCtx, SchemeHandler, SchemeManifest } from "@plurnk/plurnk-schemes";
import type { EditStatement, FindStatement, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";

// prompt:// — the worker's own task frames ({§prompt-self-only}, #527): each loop's prompt at
// prompt:///<loopSeq>/<turnSeq>, owned by the worker via owner_id — the address carries only the
// loop coordinate, so no worker identity ever rides a pathname or a packet. SELF-ONLY by
// construction: packets are per-worker and every cross-worker prompt flow (parent→child inject,
// the drain's orphan promotion) is engine-mediated, so the face takes no authority slot — a
// worker only ever addresses its own frames. Engine-authored (writableBy excludes the model);
// prompt-target log rows remain ordinary curatable memory.
export default class Prompt implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prompt",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["client", "plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        example: "<<READ(prompt:///1/1)::READ",
        documentation: "Your task frames — each loop's prompt at `prompt:///<loop>/<N>` (READ the address the User Prompts section lists). READ-ONLY: the engine writes these for you; your scratch lives at `worker://~/` and the shared blackboard at `worker:///`.",
    };

    async resolveEntryAddress(target: ParsedPath): Promise<EntryAddress | null> {
        return target.kind === "url" && target.scheme === "prompt"
            ? { pathname: target.pathname, owner: "worker" }
            : null;
    }

    // Engine and client prompt writers persist the frame owner-keyed to the
    // worker it addresses. The actionless prompt log row is written separately.
    async editBatch(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements, "worker");
    }

    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<EntryReadResult> {
        return ctx.entries.operations.read(statement, "worker");
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        return ctx.entries.operations.find(statement, "worker");
    }
}
