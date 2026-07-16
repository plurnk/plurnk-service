// Shared CRUD primitives for entry-bearing schemes (Known, Unknown, Skill).
// Per SPEC §crud — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/SEND[410].

import type { PrepMethod } from "../core/Db.ts";
import EntrySemantic from "./_entry-semantic.ts";
import { contentHash } from "../core/content-hash.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";

export type ChannelState = "static" | "active" | "closed" | "errored";

// §channels-channels-append-only: channels are content stores keyed by (entry_id, name)
export interface EntryData {
    channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    tags: string[];
}

export interface ReadEntryResult {
    status: number;
    entry: EntryData | null;
}

export interface WriteEntryResult {
    status: number;
    created: boolean;
    entryId: number | null;
    // 202 proposal: a write INTO file:/// is a disk write under §membership review —
    // carries the udiff for the client + the applyResolution inputs. Absent for
    // synchronous entry schemes (known/unknown/skill write directly).
    body?: string;
    attrs?: object;
}

export interface DeleteEntryResult {
    status: number;
    // A host-effecting delete (file) returns 202 to PROPOSE for review; attrs carry the target so
    // applyResolution can unlink on accept. Plurnk-internal deletes (known://) execute inline (200).
    attrs?: object;
}

export default class EntryCrud {
    static async readEntry(pathname: string, ctx: PlurnkSchemeContext, scheme: string | null): Promise<ReadEntryResult> {
        const { db, workspaceId } = ctx;
        const entry = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
        if (entry === undefined) return { status: 404, entry: null };

        const channelRows = await (db.crud_read_channels as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: entry.id });
        const channels: EntryData["channels"] = {};
        for (const row of channelRows) {
            channels[row.name] = { content: row.content, mimetype: row.mimetype };
        }

        const tagRows = await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: entry.id });
        const tags = tagRows.map((r) => r.tag);

        return { status: 200, entry: { channels, tags } };
    }

    static async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext, scheme: string | null): Promise<WriteEntryResult> {
        const { db, workspaceId, tokenize } = ctx;
        if (tokenize === undefined) throw new Error("writeEntry: ctx.tokenize is required for token accounting");
        const existing = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });

        let entryId: number;
        let created: boolean;
        if (existing === undefined) {
            const row = await (db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
            if (row === undefined) throw new Error("writeEntry: insert returned no row");
            entryId = row.id;
            created = true;
        } else {
            entryId = existing.id;
            created = false;
            await (db.crud_delete_channels as PrepMethod).run({ entry_id: entryId });
            await (db.crud_delete_tags as PrepMethod).run({ entry_id: entryId });
        }

        // Writes are VERBATIM — the scheme never transforms what it's handed. Web-page projection
        // (raw html → decisive markdown body + raw `html` archive) lives at the web-fetch entry point
        // (the exec sink), NOT here: an authored/workspace html file is DATA whose attributes are the
        // payload (a `<user email=…>` roster), and a reader-view projection would strip it.
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            await (db.crud_write_channel as PrepMethod).run({
                entry_id: entryId, name: channelName, content: channelData.content, mimetype: channelData.mimetype,
                tokens: tokenize(channelData.content), // the model-agnostic ruler stamp (§tokenomics-agnostic-ruler, §tokenomics-tokens-stored-at-write)
                content_hash: contentHash(channelData.content),
                state: channelData.state ?? "static",
            });
        }
        for (const tag of entry.tags) {
            await (db.crud_write_tag as PrepMethod).run({ entry_id: entryId, tag });
        }
        // §semantic-fts-at-write — the keyword half of the ~fusion indexes AT THE WRITE
        // (plain string→FTS, no handler): a cold workspace's very first query narrows over
        // everything ever written. Only the VECTOR half is derived (background pump +
        // the ~query's inline slice). NB: still NO @graph derivation here — the mimetypes
        // handler is never invoked at write (§mimetype-schemes-do-not-invoke-handlers).
        const body = entry.channels["body"];
        if (body !== undefined) await EntrySemantic.indexFts(db, entryId, body.content);

        return { status: created ? 201 : 200, created, entryId };
    }

    static async deleteEntry(pathname: string, ctx: PlurnkSchemeContext, scheme: string | null): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const existing = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, scheme, pathname });
        if (existing === undefined) return { status: 404 };
        await EntrySemantic.indexFts(db, existing.id, ""); // §semantic-fts-at-write — the keyword row dies with the entry
        await (db.crud_delete_entry as PrepMethod).run({ entry_id: existing.id });
        // CASCADE on entry_channels, entry_tags per FK constraints.
        return { status: 200 };
    }
}
