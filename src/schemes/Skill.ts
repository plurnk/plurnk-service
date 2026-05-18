// PROVISIONAL: this scheme handler exists structurally (parallel to Known/
// Unknown) but its semantics are NOT yet designed.

import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { editSessionEntry, readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { EditResult, ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { sendToSessionEntry } from "./_entry-send.ts";
import type { SendResult } from "./_entry-send.ts";
import { findSessionEntries } from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";

export default class Skill {
    static manifest: SchemeManifest = {
        name: "skill",
        channels: { body: "text/markdown", preview: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        return editSessionEntry(statement, ctx, Skill.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return readSessionEntry(statement, ctx, Skill.manifest);
    }

    async show(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return showSessionEntry(statement, ctx, Skill.manifest);
    }

    async hide(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return hideSessionEntry(statement, ctx, Skill.manifest);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return readEntry(pathname, ctx, Skill.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return writeEntry(pathname, entry, ctx, Skill.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return deleteEntry(pathname, ctx, Skill.manifest.name);
    }

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult> {
        return sendToSessionEntry(statement, ctx, Skill.manifest.name);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return findSessionEntries(statement, ctx, Skill.manifest.name);
    }
}
