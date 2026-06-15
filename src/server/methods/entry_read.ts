// entry.read — return the entry shape (all channels + tags + metadata) for a
// given path. With channel+offset, returns just that channel's content sliced
// from the offset — the incremental streaming read (#192). SPEC §methods.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";

interface Params {
    target: string;
    sessionId?: number;
    channel?: string;       // scope the read to one channel (required for offset)
    offset?: number;        // #192 — char offset; return that channel's content from here onward
}

interface ChannelShape {
    content: string;
    contentLength: number;  // full char length — the unit stream/event's contentLength + offset use, reported even when `content` is a slice
    mimetype: string;
    tokens: number;
    state: string;
}

interface EntryShape {
    id: number;
    scope: string;
    sessionId: number;
    scheme: string;
    pathname: string;
    channels: Record<string, ChannelShape>;
    tags: string[];
}

type ChannelRow = { name: string } & ChannelShape;

export default class EntryReadMethod {
    static #parsePath(s: string): { scheme: string; pathname: string } | null {
        const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
        if (m === null) return null;
        return { scheme: m[1], pathname: m[2].split("#")[0] };
    }

    static async #sliceChannel(db: Db, entryId: number, channel: string, offset: number): Promise<ChannelRow[]> {
        const r = await (db.entry_read_channel_slice as PrepMethod).get<ChannelRow>({ entry_id: entryId, channel, offset });
        return r === undefined ? [] : [r];
    }

    static async #fetchEntry(db: Db, sessionId: number, scheme: string, pathname: string, channel?: string, offset?: number): Promise<EntryShape | null> {
        const row = await (db.entry_read_lookup as PrepMethod).get<{ id: number; scope: string; session_id: number; scheme: string; pathname: string }>({
            session_id: sessionId, scheme, pathname,
        });
        if (row === undefined) return null;

        // #192 — `channel` scopes to one channel; `offset` slices its content from
        // there (substr in SQL, so only the delta leaves storage). No channel →
        // every channel, full content (the original shape).
        const channelRows = channel === undefined
            ? await (db.entry_read_channels as PrepMethod).all<ChannelRow>({ entry_id: row.id })
            : await EntryReadMethod.#sliceChannel(db, row.id, channel, offset ?? 0);
        const channels: EntryShape["channels"] = {};
        for (const c of channelRows) {
            channels[c.name] = { content: c.content, contentLength: c.contentLength, mimetype: c.mimetype, tokens: c.tokens, state: c.state };
        }

        const tagRows = await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: row.id });

        return {
            id: row.id,
            scope: row.scope,
            sessionId: row.session_id,
            scheme: row.scheme,
            pathname: row.pathname,
            channels,
            tags: tagRows.map((t) => t.tag),
        };
    }

    static register(registry: MethodRegistry): void {
        registry.registerMethod("entry.read", {
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("entry.read requires params.target: string");
                const parsed = EntryReadMethod.#parsePath(p.target);
                if (parsed === null) throw new Error(`entry.read: path must be URL-shaped (scheme://pathname); got: ${p.target}`);

                const sessionId = p.sessionId ?? ctx.session?.sessionId;
                if (sessionId === undefined) throw new Error("entry.read requires a sessionId (either via params or session attach)");

                // #192 — incremental channel read. offset is a char count (the unit
                // contentLength reports), so it requires a channel to slice.
                if (p.channel !== undefined && typeof p.channel !== "string") throw new Error("entry.read: channel must be a string");
                if (p.offset !== undefined) {
                    if (typeof p.offset !== "number" || !Number.isInteger(p.offset) || p.offset < 0) throw new Error("entry.read: offset must be a non-negative integer (char count)");
                    if (p.channel === undefined) throw new Error("entry.read: offset requires channel (which channel to slice)");
                }

                const entry = await EntryReadMethod.#fetchEntry(ctx.db, sessionId, parsed.scheme, parsed.pathname, p.channel, p.offset);
                if (entry === null) return { status: 404, entry: null };
                return { status: 200, entry };
            },
            description: "Read the entry shape (channels + tags + metadata) at the given path. With channel+offset, returns that channel's content from the offset — the incremental streaming read (#192).",
            params: {
                target: "string — entry path (URL-shaped: scheme://pathname)",
                sessionId: "number? — defaults to the connection's attached session",
                channel: "string? — scope the read to one channel (returns only it); required for offset",
                offset: "number? — #192 incremental read: that channel's content from this char offset (the unit stream/event's contentLength reports); the full contentLength comes back so the next poll reads from there",
            },
            requiresInit: true,
        });
    }
}
