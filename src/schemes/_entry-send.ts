// Shared SEND dispatcher for entry-bearing schemes. Schemes interpret
// status codes per SPEC §3.5; for v0 the only meaningful code is 410
// (Gone, delete the resource).

import type { DatabaseSync } from "node:sqlite";
import type { SendStatement } from "@plurnk/plurnk-grammar";
import { deleteEntry } from "./_entry-crud.ts";

interface SendCtx {
    db: DatabaseSync;
    statement: SendStatement;
    sessionId: number;
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

export const sendToSessionEntry = async ({ db, statement, sessionId, scheme }: SendCtx): Promise<SendResult> => {
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

    // Other status codes — entry-bearing schemes don't interpret 200 / 499 / etc.
    // Future: SEND[200] could be EDIT-via-SEND (the model says "set X to value Y" via SEND
    // instead of EDIT); SEND[499] could cancel an in-flight op on this entry. Deferred.
    return { status: 501, error: `entry scheme does not interpret SEND status ${status}` };
};
