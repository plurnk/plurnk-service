// #231 — a workspace's client-chosen open-context: the per-workspace overrides a client
// user legitimately sets at workspace.create, read at turn-0 with precedence over env.
// Two knobs with deliberately different compose semantics:
//   - filesItems: REPLACE — a single scalar; the client value wins outright over
//     PLURNK_SERVICE_FILES_ITEMS (0=off / -1=complete shallow map / N=file-map first-N).
//   - mdDocs: UNION — the server env docs (PLURNK_SERVICE_MD_*) and the client's docs ride
//     together; the systemwide policy doc survives unless the client shadows its alias.
// Storage is a JSON bag on workspaces.settings (the env mdDocs live in process.env, never
// the DB, so the union is a TS set-merge regardless — normalizing the column buys nothing).

import { readFile } from "node:fs/promises";
import Paths from "../Paths.ts";
import type { Db } from "./Db.ts";

export type ClientMdDoc = { alias: string; content: string };
export type WorkspaceOpenContext = {
    filesItems: number | null; // default-semantics — REPLACE env; null = unset (#231)
    mdDocs: ClientMdDoc[];        // default-semantics — UNION with env PLURNK_SERVICE_MD_* (#231)
    maxCommands: number | null;   // ceiling — min() with env PLURNK_SERVICE_MAX_COMMANDS; null = unset (#232)
    git: boolean | null;          // ceiling — env AND workspace; false denies git; null = unset (#232)
    client: string | null;        // #249 — workspace-stable frontend id, forwarded as Plurnk-Client (plurnk provider only); null = unset
    execs: Record<string, string> | null; // #328 — the client's PLURNK_EXECS_* policy layer; null = unset. Subtractive per-workspace narrowing over the boot registry.
    questions: boolean | null;    // {§send-300-choices} — the client's affirmative per-workspace request for operator questions ([300]); enabled = allowed (PLURNK_QUESTIONS != 0) AND requested.
};

export default class WorkspaceSettings {
    // The workspace's open-context bag. Absent/unset fields read as null / []. A malformed
    // bag never reaches here — workspace.create validates before persisting.
    static async read(db: Db, workspaceId: number): Promise<WorkspaceOpenContext> {
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspaceId });
        const bag = row?.settings !== undefined ? (JSON.parse(row.settings) as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; mdDocs?: unknown; client?: unknown; execs?: unknown; questions?: unknown }) : {};
        const filesItems = typeof bag.filesItems === "number" ? bag.filesItems : null;
        const maxCommands = typeof bag.maxCommands === "number" ? bag.maxCommands : null;
        const git = typeof bag.git === "boolean" ? bag.git : null;
        const client = typeof bag.client === "string" ? bag.client : null;
        const execs = (typeof bag.execs === "object" && bag.execs !== null && !Array.isArray(bag.execs)) ? (bag.execs as Record<string, string>) : null;
        const questions = typeof bag.questions === "boolean" ? bag.questions : null;
        const mdDocs = Array.isArray(bag.mdDocs)
            ? bag.mdDocs.filter((d): d is ClientMdDoc => typeof (d as ClientMdDoc)?.alias === "string" && typeof (d as ClientMdDoc)?.content === "string")
            : [];
        return { filesItems, mdDocs, maxCommands, git, client, execs, questions };
    }

    // {§send-300-choices} — the three-state cascade resolved: ALLOWED servicewide (PLURNK_QUESTIONS
    // != "0") AND affirmatively REQUESTED by the client for this workspace. One predicate, shared by
    // the dispatch gate and the teaching injection so capability and teaching can never desync.
    static async questionsEnabled(db: Db, workspaceId: number): Promise<boolean> {
        if (process.env.PLURNK_QUESTIONS === "0") return false;
        return (await WorkspaceSettings.read(db, workspaceId)).questions === true;
    }

    // The turn-0 reference-doc set: server env docs (PLURNK_SERVICE_MD_*, read from disk) UNION the
    // workspace's client docs (content), keyed by `<alias>.md`. On alias collision the client
    // wins before I/O — a shadowed operator path is not selected. An unshadowed configured
    // path is required and fails causally if unreadable ({§operator-config-workspace-md-docs}).
    // The set is the single source for BOTH materialization and the Engine turn-0 READ foist.
    static async resolveDocs(clientDocs: ReadonlyArray<ClientMdDoc>): Promise<Array<{ entryName: string; content: string }>> {
        const clientByEntry = new Map(clientDocs.map(({ alias, content }) => [`${alias}.md`, content]));
        const byEntry = new Map<string, string>();
        for (const { entryName, path } of Paths.docs()) {
            const clientContent = clientByEntry.get(entryName);
            if (clientContent !== undefined) {
                byEntry.set(entryName, clientContent);
                continue;
            }
            try {
                byEntry.set(entryName, await readFile(path, "utf8"));
            } catch (cause) {
                throw new Error(`configured operator reference doc '${entryName}' could not be read`, { cause });
            }
        }
        for (const [entryName, content] of clientByEntry) byEntry.set(entryName, content);
        return [...byEntry].map(([entryName, content]) => ({ entryName, content }));
    }
}
