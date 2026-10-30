// Session documentation projections of the shared workspace environment.
// Reconcile on reader demand and after workspace Functionality changes. Reference entries and
// consolidated global AGENTS(.local).md run through an ordinary `_plurnk` turn in the addressed
// session ({§session-initialization-entry}) onto `plurnk:///` and `mcp:///`.
import { createHash } from "node:crypto";
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import RuntimeSession from "../core/RuntimeSession.ts";
import {
    UNKNOWN_POSITION,
    type ParsedPath,
    type PlurnkStatement,
    type KillStatement,
} from "@plurnk/plurnk-contracts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

export default class LoopDocs {
    // {§tools-resource-materialization} {§tools-resource-materialization} —
    // the generated-reference surface tracks a content signature so repeated
    // boot/module-publish materializations dispatch nothing when nothing
    // changed (the entry layer's 304 no-op never even runs).
    static #signatures = new WeakMap<object, Map<number, string>>();
    static #materializations = new WeakMap<object, Map<number, Promise<void>>>();

    static evict(db: Db, workspaceId: number): void {
        LoopDocs.#signatures.get(db)?.delete(workspaceId);
    }

    static #target(scheme: "plurnk" | "mcp", pathname: string): ParsedPath {
        return {
            kind: "url",
            raw: `${scheme}://${pathname}`,
            scheme,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname,
            query: null,
            fragment: null,
        };
    }

    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const pending = LoopDocs.#materializations.get(db) ?? new Map<number, Promise<void>>();
        const existing = pending.get(workspaceId);
        if (existing !== undefined) return existing;
        const work = LoopDocs.#materialize(engine, db, workspaceId);
        pending.set(workspaceId, work);
        LoopDocs.#materializations.set(db, pending);
        try {
            await work;
        } finally {
            pending.delete(workspaceId);
        }
    }

    static async #materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const desired = new Map<string, { scheme: "plurnk" | "mcp"; pathname: string; content: string }>(
            (await engine.referenceEntries(workspaceId)).map((entry) => [`${entry.scheme}:${entry.pathname}`, entry]),
        );

        const signature = createHash("sha256")
            .update([...desired.entries()].map(([key, { content }]) => `${key}\u0000${content}`).join("\u0001"))
            .digest("hex");
        const byWorkspace = LoopDocs.#signatures.get(db) ?? new Map<number, string>();
        if (byWorkspace.get(workspaceId) === signature) return;

        const materialized = await db.loop_docs_materialized.all<{
            scheme: "plurnk" | "mcp";
            pathname: string;
            content: string | null;
        }>({
            workspace_id: workspaceId,
        });
        const current = new Map(materialized.map(({ scheme, pathname, content }) => [`${scheme}:${pathname}`, { scheme, pathname, content }]));
        const statements: PlurnkStatement[] = [];
        for (const [key, { scheme, pathname }] of current) {
            if (desired.has(key)) continue;
            statements.push({
                op: "KILL", aside: null,
                target: LoopDocs.#target(scheme, pathname),
                metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
            } satisfies KillStatement);
        }
        for (const [key, { scheme, pathname, content }] of desired) {
            if (current.get(key)?.content === content) continue;
            statements.push({
                op: "EDIT", aside: null,
                target: LoopDocs.#target(scheme, pathname),
                metadata: null, lineMarker: { marks: [1, -1] }, matcher: null, body: content, position: UNKNOWN_POSITION,
            });
        }

        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, await RuntimeSession.ensure(db, workspaceId), statements);
        byWorkspace.set(workspaceId, signature);
        LoopDocs.#signatures.set(db, byWorkspace);
    }
}
