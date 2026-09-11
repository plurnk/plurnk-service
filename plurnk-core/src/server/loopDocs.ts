// Worker documentation projections of the shared workspace environment.
// Reconcile on reader demand and after workspace Functionality changes. Two private sets run through
// an ordinary `_plurnk` turn in the addressed worker ({§actor-boundary-doc-injection}):
//   1. the project AGENTS.md at worker:///_plurnk/agents.md — Engine.runTurn foists
//      its READ at turn 0 ({§turn0-agents-stunt});
//   2. the exact current scheme and executable-tool reference set under
//      worker:///_plurnk/plurnk/ and worker:///_plurnk/tools/ — discovered by the
//      turn-0 FIND surveys ({§schemes-self-doc-materialization},
//      {§tools-resource-materialization}).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedPathname } from "../core/plurnk-uri.ts";
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import RuntimeWorker from "../core/RuntimeWorker.ts";
import {
    UNKNOWN_POSITION,
    type ParsedPath,
    type PlurnkStatement,
    type KillStatement,
} from "@plurnk/plurnk-contracts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";
import GitMembership from "../core/git-membership.ts";

export default class LoopDocs {
    // {§schemes-self-doc-materialization} {§tools-resource-materialization} —
    // the generated-reference surface tracks a content signature so repeated
    // boot/module-publish materializations dispatch nothing when nothing
    // changed (the entry layer's 304 no-op never even runs).
    static #signatures = new WeakMap<object, Map<number, string>>();
    static #materializations = new WeakMap<object, Map<number, Promise<void>>>();

    static evict(db: Db, workspaceId: number): void {
        LoopDocs.#signatures.get(db)?.delete(workspaceId);
    }

    // Nested AGENTS.md files below the project root (the root file has its own
    // slot), skipping dot-directories and node_modules. Deterministic order.
    static async #nestedInstructions(root: string): Promise<Array<[string, string]>> {
        const out: Array<[string, string]> = [];
        const walk = async (relative: string): Promise<void> => {
            const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
                if (entry.isDirectory()) {
                    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
                    await walk(childRelative);
                } else if (entry.name === "AGENTS.md" && relative.length > 0) {
                    const content = await readFile(join(root, childRelative), "utf8").catch(() => null);
                    if (content !== null) out.push([childRelative, content]);
                }
            }
        };
        await walk("");
        return out.toSorted((left, right) => left[0].localeCompare(right[0]));
    }

    static #target(pathname: string): ParsedPath {
        return {
            kind: "url",
            raw: `worker://${pathname}`,
            scheme: "worker",
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
        // {§turn0-agents-stunt} — the project's AGENTS.md becomes one
        // shared worker:///_plurnk/agents.md entry, read at turn 0.
        const workspace = await db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        // {§membership-model-universe} entry (3): the standard admits the content; it never overrides
        // `.gitignore` or a `hide` constraint (operator ruling, #400).
        const agentsContent = workspace?.project_root === null || workspace?.project_root === undefined
            || await GitMembership.excludesInstruction(db, workspaceId, "AGENTS.md")
            ? null
            : await readFile(join(workspace.project_root, "AGENTS.md"), "utf8").catch(() => null);
        const desired = new Map(
            (await engine.referenceEntries(workspaceId)).map(({ pathname, content }) => [pathname, content]),
        );
        if (agentsContent !== null) desired.set(generatedPathname("/agents.md"), agentsContent);
        // #346 — nested AGENTS.md honor the standard's closest-file scope:
        // each materializes at _plurnk/instructions/<subtree>/AGENTS.md with its
        // path preserved. No foisted READ and no teaching (operator-ruled):
        // the path convention is in the models' prior. This disk read is register
        // entry (3) of {§membership-model-universe}: the standard admits the
        // instruction content; the file is a member only when tracked or picked.
        if (workspace?.project_root !== null && workspace?.project_root !== undefined) {
            for (const [relative, content] of await LoopDocs.#nestedInstructions(workspace.project_root)) {
                if (await GitMembership.excludesInstruction(db, workspaceId, relative)) continue;
                desired.set(generatedPathname(`/instructions/${relative}`), content);
            }
        }

        const signature = createHash("sha256")
            .update([...desired].map(([pathname, content]) => `${pathname}\u0000${content}`).join("\u0001"))
            .digest("hex");
        const byWorkspace = LoopDocs.#signatures.get(db) ?? new Map<number, string>();
        if (byWorkspace.get(workspaceId) === signature) return;

        const materialized = await db.loop_docs_materialized.all<{
            pathname: string;
            content: string | null;
        }>({
            workspace_id: workspaceId,
        });
        const current = new Map(materialized.map(({ pathname, content }) => [pathname, content]));
        const statements: PlurnkStatement[] = [];
        for (const pathname of current.keys()) {
            if (desired.has(pathname)) continue;
            statements.push({
                op: "KILL", aside: null,
                target: LoopDocs.#target(pathname),
                metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
            } satisfies KillStatement);
        }
        for (const [pathname, content] of desired) {
            if (current.get(pathname) === content) continue;
            statements.push({
                op: "EDIT", aside: null,
                target: LoopDocs.#target(pathname),
                metadata: null, lineMarker: { marks: [1, -1] }, matcher: null, body: content, position: UNKNOWN_POSITION,
            });
        }

        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, await RuntimeWorker.ensure(db, workspaceId), statements);
        byWorkspace.set(workspaceId, signature);
        LoopDocs.#signatures.set(db, byWorkspace);
    }
}
