import type { Db } from "../core/Db.ts";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { editSessionEntry, readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { sendToSessionEntry } from "./_entry-send.ts";
import type { SendResult } from "./_entry-send.ts";
import { findSessionEntries } from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";

const SCHEME = "known";

export default class Known {
    static channels: Record<string, string> = {
        body: "text/markdown",
        preview: "text/markdown",
    };
    static defaultChannel = "body";

    async edit(ctx: { db: Db; statement: EditStatement; sessionId: number; runId: number }): Promise<EditResult> {
        return editSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async read(ctx: { db: Db; statement: ReadStatement; sessionId: number }): Promise<ReadResult> {
        return readSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async show(ctx: { db: Db; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return showSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    async hide(ctx: { db: Db; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return hideSessionEntry({ ...ctx, scheme: SCHEME, channels: Known.channels, defaultChannel: Known.defaultChannel });
    }

    // CRUD primitives (SPEC §3.2) — engine drives these for cross-scheme COPY/MOVE.
    async readEntry(ctx: { db: Db; sessionId: number; pathname: string }): Promise<ReadEntryResult> {
        return readEntry({ ...ctx, scheme: SCHEME });
    }

    async writeEntry(ctx: { db: Db; sessionId: number; pathname: string; entry: EntryData; runId: number }): Promise<WriteEntryResult> {
        return writeEntry({ ...ctx, scheme: SCHEME });
    }

    async deleteEntry(ctx: { db: Db; sessionId: number; pathname: string }): Promise<DeleteEntryResult> {
        return deleteEntry({ ...ctx, scheme: SCHEME });
    }

    async send(ctx: { db: Db; statement: SendStatement; sessionId: number; runId: number; loopId: number; turnId: number }): Promise<SendResult> {
        return sendToSessionEntry({ db: ctx.db, statement: ctx.statement, sessionId: ctx.sessionId, runId: ctx.runId, scheme: SCHEME });
    }

    async find(ctx: { db: Db; statement: FindStatement; sessionId: number; runId: number; loopId: number; turnId: number }): Promise<FindResult> {
        return findSessionEntries({ db: ctx.db, statement: ctx.statement, sessionId: ctx.sessionId, scheme: SCHEME });
    }
}
