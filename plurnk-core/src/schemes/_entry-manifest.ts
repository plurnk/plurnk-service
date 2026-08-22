// The entry catalog ({§packet-catalog}) — the complete, unranked directory for
// one addressed owner. Recursive FIND serves it recursively; shallow FIND projects it as
// a one-level map in _entry-find. An omitted owner selects the shared commons.
// Each item is a non-empty, default-first array of addressable channels.
// Search indexing is owned separately by SearchIndex.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import type {
    EntryCatalogChannel,
    EntryCatalogDefaultChannel,
    EntryStreamLifecycle,
} from "@plurnk/plurnk-schemes";
import { renderAddress } from "../core/plurnk-uri.ts";
import Owner from "../core/Owner.ts";

type ManifestRow = {
    entry_id: number;
    scheme: string;
    authority: string;
    pathname: string;
    channel: string;
    content: string;
    mimetype: string;
    weight: number;
    subscription_id: number | null;
    seconds: number | null;
    close_status: number | null;
    deep_hash: string | null;
    parse_issues: number | null;
    summary: string | null;
};

export type StreamLifecycle = EntryStreamLifecycle;
export type CatalogChannel = EntryCatalogChannel;
export type CatalogDefaultChannel = EntryCatalogDefaultChannel;

export type CatalogEntry = [CatalogDefaultChannel, ...CatalogChannel[]];

type CatalogEntryState = {
    path: string;
    defaultChannel: string;
    stream?: StreamLifecycle;
    channels: CatalogChannel[];
};

const CATALOG_SUMMARY_CODE_POINTS = 256;

const catalogSummary = (value: string | null): string | undefined => {
    if (value === null) return undefined;
    const points = [...value];
    return points.length <= CATALOG_SUMMARY_CODE_POINTS
        ? value
        : `${points.slice(0, CATALOG_SUMMARY_CODE_POINTS - 1).join("")}…`;
};

export default class EntryManifest {
    static toPath(scheme: string, authority: string, pathname: string): string {
        if (scheme === "file") return PathSyntax.escapeTarget(PathSyntax.encodeParens(pathname));
        return renderAddress({ scheme, authority, pathname });
    }

    static async catalogRowsFor(
        ctx: PlurnkSchemeContext,
        schemeFilter?: string,
        ownerId?: number,
        authorityFilter?: string,
    ): Promise<CatalogEntry[]> {
        const { db, workspaceId, mimetypes, weigh } = ctx;
        if (mimetypes === undefined) throw new Error("catalogRowsFor: ctx.mimetypes is required for the lines (extent) field");
        if (weigh === undefined) throw new Error("catalogRowsFor: ctx.weigh is required — model-independent curation weight, re-counted at render");
        const resolvedOwnerId = ownerId ?? await Owner.commonsId(db, workspaceId);
        const all = await db.engine_list_owner_entries.all<ManifestRow>({
            workspace_id: workspaceId,
            owner_id: resolvedOwnerId,
        });
        const rows = all.filter((row) =>
            (schemeFilter === undefined || row.scheme === schemeFilter)
            && (authorityFilter === undefined || row.authority === authorityFilter));
        const byEntry = new Map<string, CatalogEntryState>();
        for (const row of rows) {
            const path = EntryManifest.toPath(row.scheme, row.authority, row.pathname);
            let entry = byEntry.get(path);
            if (entry === undefined) {
                entry = {
                    path,
                    defaultChannel: ctx.defaultChannelFor?.(row.scheme) ?? "body",
                    channels: [],
                };
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
            const channelPath = row.channel === entry.defaultChannel
                ? entry.path
                : `${entry.path}#${PathSyntax.escapeTarget(row.channel)}`;
            const summary = catalogSummary(row.summary);
            entry.channels.push({
                path: channelPath,
                mimetype: row.mimetype,
                weight: weigh(row.content),
                lines: totalLines,
                ...(summary === undefined ? {} : { summary }),
                ...(row.parse_issues !== null
                    ? { parseIssues: row.parse_issues }
                    : {}),
            });
        }
        return [...byEntry.values()].map(({ path, defaultChannel, stream, channels }) => {
            const defaultIndex = channels.findIndex((channel) => channel.path === path);
            if (defaultIndex === -1) {
                throw new Error(`catalog entry ${JSON.stringify(path)} has no ${JSON.stringify(defaultChannel)} default channel`);
            }
            const defaultItem = channels[defaultIndex]!;
            const primary: CatalogDefaultChannel = stream === undefined ? defaultItem : { ...defaultItem, stream };
            return [
                primary,
                ...channels.slice(0, defaultIndex),
                ...channels.slice(defaultIndex + 1),
            ];
        });
    }
}
