// entry.read — return the full entry shape (all channels + tags + metadata)
// for a given path. SPEC §13.5.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";

interface Params {
    path: string;
    sessionId?: number;
}

interface EntryShape {
    id: number;
    scope: string;
    sessionId: number;
    scheme: string;
    pathname: string;
    channels: Record<string, { content: string; mimetype: string; tokens: number; state: string }>;
    tags: string[];
}

const parsePath = (s: string): { scheme: string; pathname: string } | null => {
    const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
    if (m === null) return null;
    return { scheme: m[1], pathname: m[2].split("#")[0] };
};

const fetchEntry = async (db: Db, sessionId: number, scheme: string, pathname: string): Promise<EntryShape | null> => {
    const row = await (db.entry_read_lookup as PrepMethod).get<{ id: number; scope: string; session_id: number; scheme: string; pathname: string }>({
        session_id: sessionId, scheme, pathname,
    });
    if (row === undefined) return null;

    const channelRows = await (db.entry_read_channels as PrepMethod).all<{ name: string; content: string; mimetype: string; tokens: number; state: string }>({ entry_id: row.id });
    const channels: EntryShape["channels"] = {};
    for (const c of channelRows) {
        channels[c.name] = { content: c.content, mimetype: c.mimetype, tokens: c.tokens, state: c.state };
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
};

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("entry.read", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.path !== "string" || p.path.length === 0) throw new Error("entry.read requires params.path: string");
            const parsed = parsePath(p.path);
            if (parsed === null) throw new Error(`entry.read: path must be URL-shaped (scheme://pathname); got: ${p.path}`);

            const sessionId = p.sessionId ?? ctx.session?.sessionId;
            if (sessionId === undefined) throw new Error("entry.read requires a sessionId (either via params or session attach)");

            const entry = await fetchEntry(ctx.db, sessionId, parsed.scheme, parsed.pathname);
            if (entry === null) return { status: 404, entry: null };
            return { status: 200, entry };
        },
        description: "Read the full entry shape (channels + tags + metadata) at the given path.",
        params: {
            path: "string — entry path (URL-shaped: scheme://pathname)",
            sessionId: "number? — defaults to the connection's attached session",
        },
        requiresInit: true,
    });
};
