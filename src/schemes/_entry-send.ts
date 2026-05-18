// Shared SEND dispatcher for entry-bearing schemes. Schemes interpret
// status codes per SPEC §3.5. v0 handles 410 (Gone, delete the resource)
// and 499 (Client Closed Request, cancel active subscription).

import type { DatabaseSync } from "node:sqlite";
import type { SendStatement } from "@plurnk/plurnk-grammar";
import { deleteEntry } from "./_entry-crud.ts";
import { findActiveSubscription } from "../core/ChannelWrite.ts";

interface SendCtx {
    db: DatabaseSync;
    statement: SendStatement;
    sessionId: number;
    runId: number;
    scheme: string;
}

export interface SendResult {
    status: number;
    [key: string]: unknown;
}

const pathnameOf = (statement: SendStatement): string | null => {
    const path = statement.path;
    if (path === null) return null;
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

const fragmentOf = (statement: SendStatement): string | null => {
    const path = statement.path;
    if (path === null || path.kind !== "url") return null;
    return path.fragment;
};

export const sendToSessionEntry = async ({ db, statement, sessionId, runId, scheme }: SendCtx): Promise<SendResult> => {
    if (statement.path === null) return { status: 400, error: "directed SEND requires a path" };

    const status = statement.signal;
    if (status === null) return { status: 400, error: "SEND requires a numeric status code" };

    // SEND[410] Gone — delete the targeted resource (SPEC §3.5).
    if (status === 410) {
        // Fragment-aware channel-level deletion is future work; reject for v0.
        if (fragmentOf(statement) !== null) {
            return { status: 400, error: "channel-level deletion (SEND[410] with #fragment) not yet supported" };
        }
        const pathname = pathnameOf(statement);
        if (pathname === null) return { status: 400 };
        const result = deleteEntry({ db, sessionId, scheme, pathname });
        return { status: result.status };
    }

    // SEND[499] Client Closed Request — cancel active subscription (SPEC §3.5, §7.7).
    // Entry-bearing schemes never have subscriptions in v0; always return 404.
    // Streaming schemes (sse / exec / etc.) override this and look up via
    // findActiveSubscription, then call their teardown using the stored handle.
    if (status === 499) {
        const pathname = pathnameOf(statement);
        if (pathname === null) return { status: 400 };
        const entry = db
            .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
            .get(sessionId, scheme, pathname) as { id: number } | undefined;
        if (entry === undefined) return { status: 404, error: "no entry at path" };
        const subscription = findActiveSubscription(db, { runId, entryId: entry.id });
        if (subscription === null) return { status: 404, error: "no active subscription to cancel" };
        // Entry-bearing schemes shouldn't have subscriptions in v0; this is reached only
        // if some other scheme opened a subscription against an entry-bearing path.
        return { status: 501, error: `entry scheme does not own subscription cancellation; subscription owned by scheme '${subscription.scheme}'` };
    }

    // Other status codes — entry-bearing schemes don't interpret 200 / etc.
    // Future: SEND[200] could be EDIT-via-SEND (the model says "set X to value Y" via SEND
    // instead of EDIT). Deferred.
    return { status: 501, error: `entry scheme does not interpret SEND status ${status}` };
};
