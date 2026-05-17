import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { editSessionEntry, readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";

export default class Unknown {
    static channels: Record<string, string> = {
        body: "text/markdown",
        preview: "text/markdown",
    };
    static defaultChannel = "body";

    async edit(ctx: { db: DatabaseSync; statement: EditStatement; sessionId: number; runId: number }): Promise<EditResult> {
        return editSessionEntry({ ...ctx, scheme: "unknown", channels: Unknown.channels, defaultChannel: Unknown.defaultChannel });
    }

    async read(ctx: { db: DatabaseSync; statement: ReadStatement; sessionId: number }): Promise<ReadResult> {
        return readSessionEntry({ ...ctx, scheme: "unknown", channels: Unknown.channels, defaultChannel: Unknown.defaultChannel });
    }

    async show(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return showSessionEntry({ ...ctx, scheme: "unknown", channels: Unknown.channels, defaultChannel: Unknown.defaultChannel });
    }

    async hide(ctx: { db: DatabaseSync; statement: ShowStatement | HideStatement; sessionId: number; runId: number }): Promise<ShowHideResult> {
        return hideSessionEntry({ ...ctx, scheme: "unknown", channels: Unknown.channels, defaultChannel: Unknown.defaultChannel });
    }
}
