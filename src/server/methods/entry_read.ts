// entry.read — return the full entry shape (all channels + tags + metadata)
// for a given path. SPEC §13.5.

import type MethodRegistry from "../MethodRegistry.ts";
import type { Db, PrepMethod } from "../../core/Db.ts";

interface Params {
    target: string;
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

export default class EntryReadMethod {
    static #parsePath(s: string): { scheme: string; pathname: string } | null {
        const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
        if (m === null) return null;
        return { scheme: m[1], pathname: m[2].split("#")[0] };
    }

    static async #fetchEntry(db: Db, sessionId: number, scheme: string, pathname: string): Promise<EntryShape | null> {
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

                const entry = await EntryReadMethod.#fetchEntry(ctx.db, sessionId, parsed.scheme, parsed.pathname);
                if (entry === null) return { status: 404, entry: null };
                return { status: 200, entry };
            },
            description: "Read the full entry shape (channels + tags + metadata) at the given path.",
            params: {
                target: "string — entry path (URL-shaped: scheme://pathname)",
                sessionId: "number? — defaults to the connection's attached session",
            },
            requiresInit: true,
        });
    }
}
