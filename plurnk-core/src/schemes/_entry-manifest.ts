// The entry catalog ({§packet-catalog}) — the complete, unranked directory of every
// entry the workspace holds. FIND(**) serves it recursively; FIND(*) projects
// it as a one-level map in _entry-find.
// Each item carries its address, optional stream lifecycle and tags, and addressable
// channels. Search indexing is owned separately by SearchIndex.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import { renderAddress } from "../core/plurnk-uri.ts";

type ManifestRow = {
    entry_id: number;
    scheme: string | null;
    pathname: string;
    channel: string;
    content: string;
    mimetype: string;
    tokens: number;
    subscription_id: number | null;
    seconds: number | null;
    close_status: number | null;
    deep_hash: string | null;
};

export type StreamLifecycle =
    | { state: "active"; seconds: number }
    | { state: "closed" | "killed" | "failed"; status: number };

export type CatalogEntry = {
    path: string;
    stream?: StreamLifecycle;
    tags?: string[];
    channels: Record<string, { mimetype: string; tokens: number; lines: number }>;
};

export default class EntryManifest {
    static toPath(scheme: string | null, pathname: string): string {
        if (scheme === "file") return PathSyntax.encodeParens(pathname);
        if (scheme === null) throw new Error(`entry '${pathname}' carries a NULL scheme — pre-v2 row survived the heal ({§entry-identity-no-null})`);
        return renderAddress(scheme, pathname);
    }

    static async catalogRowsFor(ctx: PlurnkSchemeContext, schemeFilter?: string | null, ownerId?: number): Promise<CatalogEntry[]> {
        const { db, workspaceId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("catalogRowsFor: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("catalogRowsFor: ctx.tokenize is required — the model-agnostic ruler, re-counted at render");
        const all = ownerId === undefined
            ? await db.engine_list_workspace_entries.all<ManifestRow>({ workspace_id: workspaceId })
            : await db.engine_list_worker_entries.all<ManifestRow>({ workspace_id: workspaceId, owner_id: ownerId });
        const rows = schemeFilter === undefined ? all : all.filter((row) => row.scheme === schemeFilter);
        const tagsById = new Map<number, string[]>();
        const tagRows = ownerId === undefined
            ? await db.engine_list_workspace_entry_tags.all<{ entry_id: number; tag: string }>({ workspace_id: workspaceId })
            : await db.engine_list_worker_entry_tags.all<{ entry_id: number; tag: string }>({ workspace_id: workspaceId, owner_id: ownerId });
        for (const { entry_id, tag } of tagRows) {
            const tags = tagsById.get(entry_id);
            if (tags === undefined) tagsById.set(entry_id, [tag]);
            else tags.push(tag);
        }
        const byEntry = new Map<string, CatalogEntry>();
        for (const row of rows) {
            const path = EntryManifest.toPath(row.scheme, row.pathname);
            let entry = byEntry.get(path);
            if (entry === undefined) {
                entry = { path, channels: {} };
                const tags = tagsById.get(row.entry_id);
                if (tags !== undefined && tags.length > 0) entry.tags = tags;
                byEntry.set(path, entry);
            }
            if (row.subscription_id !== null && entry.stream === undefined) {
                if (row.close_status === null) {
                    if (row.seconds === null) throw new Error(`active subscription ${row.subscription_id} has no age`);
                    entry.stream = { state: "active", seconds: row.seconds };
                } else {
                    entry.stream = {
                        state: row.close_status === 499
                            ? "killed"
                            : row.close_status >= 400 ? "failed" : "closed",
                        status: row.close_status,
                    };
                }
            }
            let totalLines: number;
            try {
                totalLines = (await mimetypes.process({ content: row.content, hint: row.mimetype }, { channels: [] })).totalLines;
            } catch {
                totalLines = row.content.length === 0 ? 0 : row.content.split("\n").length;
            }
            const defaultChannel = ctx.defaultChannelFor?.(row.scheme) ?? "body";
            const channelKey = row.channel === defaultChannel ? entry.path : `${entry.path}#${row.channel}`;
            entry.channels[channelKey] = {
                mimetype: row.mimetype,
                tokens: tokenize(row.content),
                lines: totalLines,
            };
        }
        return [...byEntry.values()];
    }
}
