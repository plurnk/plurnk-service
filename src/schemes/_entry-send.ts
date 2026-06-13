// Shared SEND dispatcher for entry-bearing schemes. Schemes interpret
// status codes per SPEC §3.5. v0 handles 410 (Gone, delete the resource)
// and 499 (Client Closed Request, cancel active subscription).

import type { SendStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryCrud from "./_entry-crud.ts";
import ChannelWrite from "../core/ChannelWrite.ts";

export interface SendResult {
    status: number;
    [key: string]: unknown;
}

export default class EntrySend {
    static #pathnameOf(statement: SendStatement): string | null {
        const path = statement.target;
        if (path === null) return null;
        if (path.kind === "url") return path.pathname;
        return path.raw;
    }

    static #fragmentOf(statement: SendStatement): string | null {
        const path = statement.target;
        if (path === null || path.kind !== "url") return null;
        return path.fragment;
    }

    static async sendToSessionEntry(statement: SendStatement, ctx: PlurnkSchemeContext, scheme: string): Promise<SendResult> {
        if (statement.target === null) return { status: 400, error: "directed SEND requires a path" };

        const status = statement.signal;
        if (status === null) return { status: 400, error: "SEND requires a numeric status code" };

        // SEND[410] Gone — delete the targeted resource (SPEC §3.5). With a
        // #fragment, deletes just that channel; without, deletes the whole entry.
        if (status === 410) {
            const pathname = EntrySend.#pathnameOf(statement);
            if (pathname === null) return { status: 400 };
            const fragment = EntrySend.#fragmentOf(statement);
            if (fragment !== null) {
                const { db, sessionId } = ctx;
                const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
                if (entry === undefined) return { status: 404 };
                const deleted = await (db.crud_delete_channel as PrepMethod).get<{ name: string }>({ entry_id: entry.id, name: fragment });
                return { status: deleted === undefined ? 404 : 200 };
            }
            const result = await EntryCrud.deleteEntry(pathname, ctx, scheme);
            return { status: result.status };
        }

        // SEND[499] Client Closed Request — cancel active subscription (SPEC §3.5, §7.5).
        // Entry-bearing schemes never have subscriptions in v0; always return 404.
        // Streaming schemes (sse / exec / etc.) override this and look up via
        // findActiveSubscription, then call their teardown using the stored handle.
        if (status === 499) {
            const pathname = EntrySend.#pathnameOf(statement);
            if (pathname === null) return { status: 400 };
            const { db, sessionId, runId } = ctx;
            const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
            if (entry === undefined) return { status: 404, error: "no entry at path" };
            const subscription = await ChannelWrite.findActiveSubscription(db, { runId, entryId: entry.id });
            if (subscription === null) return { status: 404, error: "no active subscription to cancel" };
            return { status: 501, error: `entry scheme does not own subscription cancellation; subscription owned by scheme '${subscription.scheme}'` };
        }

        return { status: 501, error: `entry scheme does not interpret SEND status ${status}` };
    }
}
