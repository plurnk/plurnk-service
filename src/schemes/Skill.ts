// PROVISIONAL: this scheme handler exists structurally (parallel to Known/
// Unknown) but its semantics are NOT yet designed. Skill discovery, self-
// registration, activation patterns, the distinction between a "skill"
// and a "known" — all open. Do NOT build new behavior on top of this until
// the semantics are settled. Storage parity with Known/Unknown is
// deliberate; semantic divergence is expected when it lands properly.

import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { editSessionEntry, readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";

const SCHEME = "skill";

export default class Skill {
    async edit(ctx: { db: DatabaseSync; statement: EditStatement; sessionId: number; runId: number }): Promise<EditResult> {
        return editSessionEntry({ ...ctx, scheme: SCHEME });
    }

    async read(ctx: { db: DatabaseSync; statement: ReadStatement; sessionId: number }): Promise<ReadResult> {
        return readSessionEntry({ ...ctx, scheme: SCHEME });
    }

    async show(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return showSessionEntry({ ...ctx, scheme: SCHEME });
    }

    async hide(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return hideSessionEntry({ ...ctx, scheme: SCHEME });
    }
}
