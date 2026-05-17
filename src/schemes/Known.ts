import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { editSessionEntry, readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";

const SCHEME = "known";

export default class Known {
    static channels: Record<string, string> = {
        body: "text/markdown",
        preview: "text/markdown",
    };
    static defaultChannel = "body";

    async edit(ctx: { db: DatabaseSync; statement: EditStatement; sessionId: number; runId: number }): Promise<EditResult> {
        return editSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async read(ctx: { db: DatabaseSync; statement: ReadStatement; sessionId: number }): Promise<ReadResult> {
        return readSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async show(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return showSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async hide(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return hideSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    // CRUD primitives (SPEC §3.2) — engine drives these for cross-scheme COPY/MOVE.
    async readEntry(ctx: { db: DatabaseSync; sessionId: number; pathname: string }): Promise<ReadEntryResult> {
        return readEntry({ ...ctx, scheme: SCHEME });
    }

    async writeEntry(ctx: { db: DatabaseSync; sessionId: number; pathname: string; entry: EntryData; runId: number }): Promise<WriteEntryResult> {
        return writeEntry({ ...ctx, scheme: SCHEME });
    }

    async deleteEntry(ctx: { db: DatabaseSync; sessionId: number; pathname: string }): Promise<DeleteEntryResult> {
        return deleteEntry({ ...ctx, scheme: SCHEME });
    }
}
