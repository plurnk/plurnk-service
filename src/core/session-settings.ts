// #231 — a session's client-chosen open-context: the per-session overrides a client
// user legitimately sets at session.create, read at turn-0 with precedence over env.
// Two knobs with deliberately different compose semantics:
//   - filesItems: REPLACE — a single scalar; the client value wins outright over
//     PLURNK_SERVICE_FILES_ITEMS (normalization — 0=off / -1=full / N=first-N — stays in Engine).
//   - mdDocs: UNION — the server env docs (PLURNK_SERVICE_MD_*) and the client's docs ride
//     together; the systemwide policy doc survives unless the client shadows its alias.
// Storage is a JSON bag on sessions.settings (the env mdDocs live in process.env, never
// the DB, so the union is a TS set-merge regardless — normalizing the column buys nothing).

import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import type { Db, PrepMethod } from "./Db.ts";

export type ClientMdDoc = { alias: string; content: string };
export type SessionOpenContext = {
    filesItems: number | null; // default-semantics — REPLACE env; null = unset (#231)
    mdDocs: ClientMdDoc[];        // default-semantics — UNION with env PLURNK_SERVICE_MD_* (#231)
    maxCommands: number | null;   // ceiling — min() with env PLURNK_SERVICE_MAX_COMMANDS; null = unset (#232)
    git: boolean | null;          // ceiling — env AND session; false denies git; null = unset (#232)
    client: string | null;        // #249 — session-stable frontend id, forwarded as Plurnk-Client (plurnk provider only); null = unset
};

export default class SessionSettings {
    // The session's open-context bag. Absent/unset fields read as null / []. A malformed
    // bag never reaches here — session.create validates before persisting.
    static async read(db: Db, sessionId: number): Promise<SessionOpenContext> {
        const row = await (db.session_get_settings as PrepMethod).get<{ settings: string }>({ session_id: sessionId });
        const bag = row?.settings !== undefined ? (JSON.parse(row.settings) as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; mdDocs?: unknown; client?: unknown }) : {};
        const filesItems = typeof bag.filesItems === "number" ? bag.filesItems : null;
        const maxCommands = typeof bag.maxCommands === "number" ? bag.maxCommands : null;
        const git = typeof bag.git === "boolean" ? bag.git : null;
        const client = typeof bag.client === "string" ? bag.client : null;
        const mdDocs = Array.isArray(bag.mdDocs)
            ? bag.mdDocs.filter((d): d is ClientMdDoc => typeof (d as ClientMdDoc)?.alias === "string" && typeof (d as ClientMdDoc)?.content === "string")
            : [];
        return { filesItems, mdDocs, maxCommands, git, client };
    }

    // The turn-0 reference-doc set: server env docs (PLURNK_SERVICE_MD_*, read from disk) UNION the
    // session's client docs (content), keyed by `<alias>.md`. On alias collision the client
    // wins — it may deliberately shadow a server doc, but by default the policy doc rides
    // along. Missing env files are skipped (same as the env-only path before #231). The set
    // is the single source for BOTH the loop_run materialize and the Engine turn-0 READ foist.
    static async resolveDocs(clientDocs: ReadonlyArray<ClientMdDoc>): Promise<Array<{ entryName: string; content: string }>> {
        const byEntry = new Map<string, string>();
        for (const { entryName, path } of Paths.docs()) {
            try { byEntry.set(entryName, await readFile(path, "utf8")); } catch { /* missing → skip */ }
        }
        for (const { alias, content } of clientDocs) byEntry.set(`${alias}.md`, content); // client wins
        return [...byEntry].map(([entryName, content]) => ({ entryName, content }));
    }
}
