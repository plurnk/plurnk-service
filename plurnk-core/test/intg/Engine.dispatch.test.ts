import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import Envelope from "../../src/server/envelope.ts";
import assert from "node:assert/strict";
import { InvalidTagSignalError } from "@plurnk/plurnk-contracts";
import type { TextLineMarker, EditStatement, ReadStatement, KillStatement, PlanStatement, OpenStatement, FoldStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";
import type { ResolvedEditStatement, SchemeCtx } from "@plurnk/plurnk-schemes";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (opts: { target: ParsedPath; tags?: string[] | null; body?: string | null; marker?: TextLineMarker | null; annotation?: string | null }): EditStatement => ({
    op: "EDIT", annotation: opts.annotation ?? null, delimiter: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { target: ParsedPath; tags?: string[] | null; marker?: ReadStatement["lineMarker"] }): ReadStatement => ({
    op: "READ", annotation: null, delimiter: "",
    signal: opts.tags ?? null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    body: null,
    position: { line: 1, column: 1 },
});

const killStmt = (opts: { target: ParsedPath; body?: string | null }): KillStatement => ({
    op: "KILL", annotation: null, delimiter: "",
    signal: null,
    target: opts.target,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const planStmt = (opts: { body?: string | null }): PlanStatement => ({
    op: "PLAN", annotation: null, delimiter: "",
    signal: null,
    target: null,
    lineMarker: null,
    body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const openStmt = (opts: { target: ParsedPath | null; tags?: string[] }): OpenStatement => ({
    op: "OPEN", annotation: null, delimiter: "", signal: opts.tags ?? null, target: opts.target,
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

const foldStmt = (opts: { target: ParsedPath | null; tags?: string[]; marker?: TextLineMarker | null }): FoldStatement => ({
    op: "FOLD", annotation: null, delimiter: "", signal: opts.tags ?? null, target: opts.target,
    lineMarker: opts.marker ?? null, body: null, position: { line: 1, column: 1 },
});

test("Engine.dispatch: KILL against worker:/// permanently deletes the entry (200, then READ 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/obsolete/note"), body: "stale" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/obsolete/note") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200);
        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("worker", "/obsolete/note") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("worker:///x (authority form) folds to the same entry as worker:///x", async () => {
    const { db, engine, env } = await setup();
    try {
        // create via the path form: skill:///config.json => /config.json
        await engine.dispatch({
            statement: editStmt({ target: urlPath("skill", "/config.json"), body: "host=db.internal" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        // worker:///config.json => authority "config.json", empty path; #extractTarget folds it to /config.json,
        // the same entry the path form created. Without the fold the authority drops to "" and this 404s.
        const authForm: UrlPath = { kind: "url", raw: "skill://config.json", scheme: "skill", username: null, password: null, hostname: "config.json", port: null, pathname: "", query: null, fragment: null };
        const read = await engine.dispatch({
            statement: readStmt({ target: authForm }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL on a nonexistent entry returns 404", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/never/existed") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

test("Engine.dispatch: the KILL body annotation survives into the log row's tx (even on a 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: killStmt({ target: urlPath("worker", "/gone"), body: "superseded — see /final" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("KILL log_entry not found");
        assert.equal(log.op, "KILL");
        const tx = JSON.parse(log.tx) as { body: string | null };
        assert.equal(tx.body, "superseded — see /final");
    } finally { await db.close(); }
});

test("{§operation-annotation}: the descriptive annotation survives durable dispatch unchanged", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({
                target: urlPath("worker", "/annotated"),
                body: "content",
                annotation: "Create the shared note",
            }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("annotated EDIT log_entry not found");
        const tx = JSON.parse(log.tx) as { annotation: unknown };
        assert.equal(tx.annotation, "Create the shared note");
    } finally { await db.close(); }
});

test("Engine.dispatch: KILL against a non-running exec:/// returns 404 (nothing to kill)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("exec", "/sh/1/1/2") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

// {§model-entry-log-curation}
test("Engine.dispatch preserves log KILL's missing-coordinate failure", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/0") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "plurnk",
        });
        assert.equal(kill.status, 404, "a missing log coordinate remains not found");
    } finally { await db.close(); }
});

test("model-origin KILL passes the log write gate and erases the addressed row", async () => {
    const { db, engine, env } = await setup();
    try {
        // A real model-origin row at coordinate /1/1/1 (loop seq 1, turn seq 1, sequence 1).
        const plan = await engine.dispatch({
            statement: planStmt({ body: "obsolete goals to curate away" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "the model is authorized to erase its log item");
        const gone = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(gone.status, 404, "a second KILL proves the row was erased");
    } finally { await db.close(); }
});

test("Engine.dispatch: PLAN is a logged no-op (200) whose intended goals survive into the log row's tx", async () => {
    const { db, engine, env } = await setup();
    try {
        const plan = await engine.dispatch({
            statement: planStmt({ body: "capital of France is unknown; FIND before READ" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("PLAN log_entry not found");
        assert.equal(log.op, "PLAN");
        const tx = JSON.parse(log.tx) as { body: string | null };
        assert.equal(tx.body, "capital of France is unknown; FIND before READ");
    } finally { await db.close(); }
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, engine, env };
};

test("Engine.dispatch: operation tags classify their own durable log item, including failures", async () => {
    const { db, engine, env } = await setup();
    try {
        const edited = await engine.dispatch({
            statement: editStmt({
                target: urlPath("worker", "/classified"),
                body: "classified body",
                tags: ["+work", "+shared"],
            }),
            ...env, sequence: 1, origin: "model",
        });
        assert.equal(edited.status, 201);

        const failed = await engine.dispatch({
            statement: readStmt({
                target: urlPath("worker", "/missing"),
                tags: ["failure", "shared"],
            }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(failed.status, 404);

        const tags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({
            worker_id: env.workerId,
        });
        assert.deepEqual(tags, [
            { coordinate: "1/1/1", tag: "shared" },
            { coordinate: "1/1/1", tag: "work" },
            { coordinate: "1/1/2", tag: "failure" },
            { coordinate: "1/1/2", tag: "shared" },
        ]);
    } finally { await db.close(); }
});

test("Engine.dispatch: targetless FOLD[tag] and OPEN[tag] symmetrically filter log items", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/classified"), body: "body", tags: ["+working-set"] }),
            ...env, sequence: 1, origin: "model",
        });
        const folded = await engine.dispatch({
            statement: foldStmt({ target: null, tags: ["working-set"] }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(folded.status, 200);
        assert.equal((folded as { matched?: number }).matched, 1);
        const before = await db.test_get_log_folded.get<{ folded: string }>({
            worker_id: env.workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(before?.folded, "[[1,-1]]");

        const opened = await engine.dispatch({
            statement: openStmt({ target: null, tags: ["working-set"] }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(opened.status, 200);
        assert.equal((opened as { matched?: number }).matched, 1);
        const after = await db.test_get_log_folded.get<{ folded: string }>({
            worker_id: env.workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(after?.folded, "[]");
    } finally { await db.close(); }
});

test("Engine.dispatch: FOLD/OPEN atomically change visibility and exact tag classifications", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({
                target: urlPath("worker", "/one"),
                body: "one",
                tags: ["+research", "+stale"],
            }),
            ...env, sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: editStmt({
                target: urlPath("worker", "/two"),
                body: "two",
                tags: ["+research"],
            }),
            ...env, sequence: 2, origin: "model",
        });

        const folded = await engine.dispatch({
            statement: foldStmt({ target: null, tags: ["research", "+archive", "-stale"] }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(folded.status, 200);
        assert.equal((folded as { matched?: number }).matched, 2);
        assert.deepEqual(
            await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: env.workerId }),
            [
                { coordinate: "1/1/1", tag: "archive" },
                { coordinate: "1/1/1", tag: "research" },
                { coordinate: "1/1/2", tag: "archive" },
                { coordinate: "1/1/2", tag: "research" },
            ],
        );
        const foldEffects = (await db.test_log_curation_effects_by_worker.all<{
            operation_sequence: number;
            target_sequence: number;
            folded_before: string;
            tags_added: string;
            tags_removed: string;
        }>({ worker_id: env.workerId })).filter(({ operation_sequence }) => operation_sequence === 3);
        assert.deepEqual(foldEffects.map((effect) => ({
            target: effect.target_sequence,
            foldedBefore: JSON.parse(effect.folded_before),
            added: JSON.parse(effect.tags_added),
            removed: JSON.parse(effect.tags_removed),
        })), [
            { target: 1, foldedBefore: [], added: ["archive"], removed: ["stale"] },
            { target: 2, foldedBefore: [], added: ["archive"], removed: [] },
        ]);

        const opened = await engine.dispatch({
            statement: openStmt({ target: null, tags: ["archive", "-archive"] }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(opened.status, 200);
        assert.equal((opened as { matched?: number }).matched, 2);
        assert.deepEqual(
            await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: env.workerId }),
            [
                { coordinate: "1/1/1", tag: "research" },
                { coordinate: "1/1/2", tag: "research" },
            ],
        );
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; attrs: string }>({ turn_id: env.turnId });
        assert.ok(rows.every(({ attrs }) => !("__plurnk_curation" in JSON.parse(attrs))), "the bound curation plan is never durable");
    } finally { await db.close(); }
});

test("Engine.dispatch: an external scheme cannot acquire OPEN by defining an open method", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let invoked = false;
    class Trap {
        static manifest = {
            name: "trap", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async open() { invoked = true; return { status: 200 }; }
    }
    schemes.register("trap", new Trap());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: openStmt({ target: urlPath("trap", "/x") }),
            ...env, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        assert.equal(result.problem?.operation, "OPEN");
        assert.equal(result.problem?.scheme, "trap");
        assert.equal(invoked, false);
    } finally { await db.close(); }
});

test("Engine.dispatch: EDIT against worker:/// routes to Worker.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/france/capital"), body: "Paris", tags: ["+france"] }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entryId = (result as unknown as { entryId: number }).entryId;
        assert.ok(entryId >= 1);
        const entry = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: entryId });
        assert.equal(entry?.pathname, "/france/capital");
    } finally { await db.close(); }
});

test("Engine.dispatch: a current READ line anchor lowers to a numeric EDIT precondition", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("worker", "/anchored.md");
    const identity = "worker:///anchored.md";
    try {
        assert.equal((await engine.dispatch({
            statement: editStmt({ target, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);

        const original = "alpha\nbeta\ngamma";
        const beta = LineAnchors.token(identity, 2, original);
        const gamma = LineAnchors.token(identity, 3, original);
        const edited = await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [beta] }, body: "BETA" }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(edited.status, 200);

        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 200);
        assert.equal((read as { content?: string }).content, "alpha\nBETA\ngamma");

        const stale = await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [gamma] }, body: "GAMMA" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.dev/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, `EDIT collided with another change at ${identity}.`);
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("Engine.dispatch: READ accepts a current line anchor and rejects a stale one as a collision", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("worker", "/anchor-read.md");
    try {
        assert.equal((await engine.dispatch({
            statement: editStmt({ target, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const numeric = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [2] } }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (numeric as { lineAnchors?: readonly string[] }).lineAnchors?.[0];
        assert.match(anchor ?? "", /^@[0-9A-Za-z]{5}$/);

        const anchored = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [anchor!] } }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(anchored.status, 200);
        assert.equal((anchored as { content?: string }).content, "beta");

        assert.equal((await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [2] }, body: "BETA" }),
            ...env, sequence: 4, origin: "model",
        })).status, 200);
        const stale = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [anchor!] } }),
            ...env, sequence: 5, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.dev/scheme/worker/line-anchor-collision");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("Engine.dispatch: FOLD accepts both a log body's published anchors and anchors from READing the log", async () => {
    const { db, engine, env } = await setup();
    const content = "alpha\nbeta\ngamma";
    const target = urlPath("log", "/1/1/1/READ");
    const publishedAnchors = LineAnchors.tokens("worker:///source.md", content);
    try {
        await db.engine_insert_log_entry.get({
            worker_id: env.workerId, loop_id: env.loopId, turn_id: env.turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ", delimiter: "", signal: null,
            scheme: "worker", username: null, password: null, hostname: null, port: null,
            pathname: "/source.md", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({
                status: 200,
                content,
                mimetype: "text/plain",
                startLine: 17,
                lineAnchorIdentity: "worker:///source.md",
                lineAnchors: publishedAnchors,
                lineNumberWidth: 2,
            }),
            mimetype_rx: "application/json", status_rx: 200, weight: content.length,
            state: "resolved", outcome: null, attrs: "{}",
        });

        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
        const logAnchors = (read as { lineAnchors?: readonly string[] }).lineAnchors;
        assert.equal(logAnchors?.[1], LineAnchors.token("log:///1/1/1/READ", 2, content));

        const foldedFromBody = await engine.dispatch({
            statement: foldStmt({ target, marker: { marks: [publishedAnchors[1]!] } }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(foldedFromBody.status, 200);
        const foldedFromLogRead = await engine.dispatch({
            statement: foldStmt({ target, marker: { marks: [logAnchors![2]!] } }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(foldedFromLogRead.status, 200);
        const row = await db.test_get_log_folded.get<{ folded: string }>({
            worker_id: env.workerId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(row?.folded, "[[2,3]]");
    } finally { await db.close(); }
});

test("Engine.dispatch: a scoped READ anchor includes nearby lines outside the returned slice", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("worker", "/contextual-anchor.md");
    const content = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    try {
        assert.equal((await engine.dispatch({
            statement: editStmt({ target, body: content }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);

        const read = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [5] } }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
        assert.equal((read as { content?: string }).content, "line-5");
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[0];
        assert.match(anchor ?? "", /^@[0-9A-Za-z]{5}$/);

        assert.equal((await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [7] }, body: "changed-nearby" }),
            ...env, sequence: 3, origin: "model",
        })).status, 200);

        const stale = await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [anchor!] }, body: "changed-target" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.dev/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, "EDIT collided with another change at worker:///contextual-anchor.md.");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("Engine.dispatch: a mutation between anchor resolution and landing is an edit collision", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-race-${crypto.randomUUID()}`);
    const target = urlPath("racy", "/unit.md");
    const identity = "racy:///unit.md";
    let intervene = false;
    const schemes = new SchemeRegistry();
    schemes.register("racy", {
        manifest: {
            name: "racy",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
            textEditScopes: true,
        },
        async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx) {
            if (intervene) {
                const changed = await ctx.entries.write("/unit.md", {
                    channels: {
                        body: {
                            content: "alpha\nother worker\ngamma",
                            mimetype: "text/markdown",
                        },
                    },
                });
                assert.equal(changed.status, 200);
            }
            return ctx.entries.operations.editBatch(statements);
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        const original = "alpha\nbeta\ngamma";
        assert.equal((await engine.dispatch({
            statement: editStmt({ target, body: original }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const read = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[1];
        assert.equal(anchor, LineAnchors.token(identity, 2, original));

        intervene = true;
        const collided = await engine.dispatch({
            statement: editStmt({ target, marker: { marks: [anchor!] }, body: "authored edit" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(collided.status, 409);
        assert.equal(collided.problem?.type, "https://problems.plurnk.dev/engine/edit/edit-collision");
        assert.equal(collided.problem?.detail, `EDIT collided with another change at ${identity}.`);
        assert.equal(collided.problem?.anchor, undefined);

        const stored = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/unit.md",
            scheme: "racy",
            name: "body",
        });
        assert.equal(stored?.content, "alpha\nother worker\ngamma");
    } finally { await db.close(); }
});

test("Engine.dispatch: an anchored EDIT retains the READ owner's canonical resource identity", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-alias-${crypto.randomUUID()}`);
    const alias = urlPath("aliased", "/alias.md");
    const canonical = urlPath("aliased", "/canonical.md");
    const schemes = new SchemeRegistry();
    schemes.register("aliased", {
        manifest: {
            name: "aliased",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
            textEditScopes: true,
        },
        async resolveEntryAddress() {
            return { pathname: "/canonical.md", owner: "commons" as const };
        },
        async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx) {
            return ctx.entries.operations.editBatch(statements.map((statement) => ({
                ...statement,
                target: canonical,
            })));
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        assert.equal((await engine.dispatch({
            statement: editStmt({ target: alias, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const read = await engine.dispatch({
            statement: readStmt({ target: alias }),
            ...env, sequence: 2, origin: "model",
        });
        const anchor = (read as { lineAnchors?: readonly string[] }).lineAnchors?.[1];
        assert.equal((read as { lineAnchorIdentity?: string }).lineAnchorIdentity, "aliased:///canonical.md");
        assert.equal(anchor, LineAnchors.token("aliased:///canonical.md", 2, "alpha\nbeta\ngamma"));

        const edited = await engine.dispatch({
            statement: editStmt({ target: alias, marker: { marks: [anchor!] }, body: "BETA" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(edited.status, 200);
    } finally { await db.close(); }
});

test("Engine.dispatch: a scheme without textual EDIT scopes rejects an anchor before invocation", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `anchor-boundary-${crypto.randomUUID()}`);
    let invoked = false;
    const schemes = new SchemeRegistry();
    schemes.register("whole", {
        manifest: {
            name: "whole",
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        },
        async editBatch() {
            invoked = true;
            return { status: 200 };
        },
    });
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({
                target: urlPath("whole", "/unit"),
                marker: { marks: ["@aZ09b"] },
                body: "replacement",
            }),
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/line-anchor-unsupported");
        assert.equal(invoked, false);
    } finally { await db.close(); }
});

test("Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{
            worker_id: number; loop_id: number; turn_id: number; sequence: number;
            origin: string; op: string; delimiter: string; signal: string | null;
            scheme: string | null; pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("log_entry not found");
        assert.equal(log.worker_id, env.workerId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.sequence, 1);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(log.delimiter, "");
        assert.equal(log.signal, null);
        assert.equal(log.scheme, "worker");
        assert.equal(log.pathname, "/x");
        assert.equal(log.mimetype_tx, "application/json");
        assert.equal(log.mimetype_rx, "application/json");
        assert.equal(log.status_rx, 201);
        const tx = JSON.parse(log.tx) as { op: string };
        assert.equal(tx.op, "EDIT");
        const rx = JSON.parse(log.rx) as { status: number };
        assert.equal(rx.status, 201);
    } finally { await db.close(); }
});

test("Engine.dispatch: READ against worker:/// routes to Worker.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/r"), body: "value" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("worker", "/r") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { await db.close(); }
});

test("Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("wiki", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 501);
        assert.equal(log?.scheme, "wiki");
    } finally { await db.close(); }
});

test("Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            op: "EDIT", annotation: null, delimiter: "", signal: null, target: null, lineMarker: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string | null; pathname: string | null }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 400);
        assert.equal(log?.scheme, null);
        assert.equal(log?.pathname, null);
    } finally { await db.close(); }
});

test("Engine.dispatch: multiple actions in one turn — log_entries sequence UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/a"), body: "1" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/b"), body: "2" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; pathname: string }>({ turn_id: env.turnId });
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.sequence, 1);
        assert.equal(rows[0]?.pathname, "/a");
        assert.equal(rows[1]?.sequence, 2);
        assert.equal(rows[1]?.pathname, "/b");
    } finally { await db.close(); }
});

test("Engine.dispatch: signal serialized to JSON in log", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/tagged"), tags: ["+france", "+europe"], body: "Paris" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ signal: string }>({ turn_id: env.turnId });
        assert.deepEqual(JSON.parse(log?.signal ?? "null"), ["+france", "+europe"]);
    } finally { await db.close(); }
});

test("Engine.dispatch: an invalid classifying signal fails before EDIT mutates a resource", async () => {
    const { db, engine, env } = await setup();
    try {
        await assert.rejects(
            engine.dispatch({
                statement: editStmt({ target: urlPath("worker", "/invalid-tag"), tags: ["-research"], body: "must not land" }),
                workspaceId: env.workspaceId,
                workerId: env.workerId,
                loopId: env.loopId,
                turnId: env.turnId,
                sequence: 1,
                origin: "model",
            }),
            InvalidTagSignalError,
        );
        const count = await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: env.turnId });
        assert.equal(count?.n, 0);

        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("worker", "/invalid-tag") }),
            workspaceId: env.workspaceId,
            workerId: env.workerId,
            loopId: env.loopId,
            turnId: env.turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        for (const [i, origin] of (["model", "client", "plurnk", "plugin"] as const).entries()) {
            await engine.dispatch({
                statement: editStmt({ target: urlPath("worker", `/o${i}`), body: "x" }),
                workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
                sequence: i + 1, origin,
            });
        }
        const rows = await db.test_log_entries_by_turn.all<{ origin: string; sequence: number }>({ turn_id: env.turnId });
        assert.deepEqual(rows.map((r) => r.origin), ["model", "client", "plurnk", "plugin"]);
    } finally { await db.close(); }
});

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy or dispatch
// returns 403 without invoking the handler.

test("Engine.dispatch: a writer outside writableBy is rejected 403 without invoking the handler", async () => {
    const { db, engine, env } = await setup();
    try {
        // worker://'s writableBy is ['model','client','plurnk'] — a plugin-origin EDIT 403s at the gate.
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "plugin",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/writer-forbidden");
        assert.equal(result.problem?.writer, "plugin");
        assert.equal(result.problem?.scheme, "worker");
        assert.deepEqual(result.problem?.allowedWriters, ["model", "client", "plurnk"]);
        // 403 still writes a log row
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 403);
        assert.equal(log?.scheme, "worker");
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT log:/// clears the gate but 501s — Log's handler surface (kill only) is the op-level truth", async () => {
    // {§model-entry-log-curation} admits the model through Log's writableBy for its KILL curation
    // lever; every other mutating op still lands on a handler Log doesn't expose (no edit) → 501,
    // matching plurnk.md's "Do not attempt to edit log items."
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501, "op-level refusal (no edit handler), not the writer gate");
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT prompt:/// rejected with 403 (engine/client own the task frames)", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("prompt", "/1/1"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: model EDIT worker://plurnk/ is 403 — only the kernel authors its surface ({})", async () => {
    const { db, engine, env } = await setup();
    try {
        await Owner.commonsId(db, env.workspaceId); // ensure reserved rows resolvable
        await Envelope.ensurePlurnkWorker(db, env.workspaceId);
        const result = await engine.dispatch({
            statement: editStmt({ target: { kind: "url", raw: "worker://plurnk/docs/log.md", scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: "/docs/log.md", query: null, fragment: null }, body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "a named space takes no model writes — the kernel surface included");
    } finally { await db.close(); }
});

test("Engine.dispatch: model READ log:/// is NOT gated by writableBy (read-side op)", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log scheme has no read() handler yet, so this returns 501 — proves
        // the writableBy gate did NOT intercept (would have returned 403).
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("log", "/x") }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: plurnk EDIT log:/// is allowed by writableBy", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log has no edit() handler — so this returns 501 (not 403) when allowed.
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "plurnk",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("Engine.dispatch: an instance manifest enforces writableBy like a static manifest", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let invoked = false;
    class Dynamic {
        get manifest() {
            return {
                name: "dynamic",
                channels: {},
                defaultChannel: "",
                category: "data" as const,
                writableBy: ["plugin" as const],
                volatile: false,
                modelVisible: true,
            };
        }
        async editBatch() {
            invoked = true;
            return { status: 200 };
        }
    }
    schemes.register("dynamic", new Dynamic());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("dynamic", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(invoked, false, "the handler is not invoked after its manifest denies the writer");
    } finally { await db.close(); }
});

test("Engine.dispatch: model SEND with null path (broadcast) is NOT gated", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: { op: "SEND", annotation: null, delimiter: "", signal: 200, target: null, lineMarker: null, body: null, position: { line: 1, column: 1 } },
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// {§scheme-surface-exception-500} Scheme-handler
// exceptions finalize the action-entry at 500, not bubble up.

test("Engine.dispatch: scheme handler that throws → action-entry at status 500 (action-entry-as-outcome)", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class Boom {
        static manifest = {
            name: "boom", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch() { throw new Error("scheme handler deliberately threw"); }
    }
    schemes.register("boom", new Boom());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boom", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.detail, "The 'boom' scheme did not produce an EDIT result.");
        assert.equal(result.problem?.stage, "scheme-dispatch");
        assert.equal(result.problem?.scheme, "boom");
        assert.equal(result.problem?.operation, "EDIT");
        assert.doesNotMatch(JSON.stringify(result), /scheme handler deliberately threw/);
        // action-entry preserved at status 500 with error in rx
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; rx: string; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 500);
        assert.equal(log?.scheme, "boom");
        const rx = JSON.parse(log?.rx ?? "{}");
        assert.equal(rx.status, 500);
        assert.equal(rx.problem.detail, "The 'boom' scheme did not produce an EDIT result.");
        assert.doesNotMatch(log?.rx ?? "", /scheme handler deliberately threw/);
    } finally { await db.close(); }
});

test("Engine.dispatch: non-Error throw becomes the same generic contract Problem", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class BoomString {
        static manifest = {
            name: "boomstr", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch(): Promise<never> { throw "raw string thrown"; }
    }
    schemes.register("boomstr", new BoomString());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: editStmt({ target: urlPath("boomstr", "/x"), body: "y" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/engine/dispatcher/scheme-handler-threw");
        assert.equal(result.problem?.detail, "The 'boomstr' scheme did not produce an EDIT result.");
        assert.doesNotMatch(JSON.stringify(result), /raw string thrown/);
    } finally { await db.close(); }
});

test("Engine.dispatch: COPY rejects a non-entry destination at resource resolution", async () => {
    const { db, engine, env } = await setup();
    try {
        // Source first: model creates an entry in worker:///.
        await engine.dispatch({
            statement: editStmt({ target: urlPath("worker", "/src"), body: "v" }),
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        // Attempt copy worker:///src → log:///dst — destination scheme rejects.
        const result = await engine.dispatch({
            statement: {
                op: "COPY", annotation: null, delimiter: "", signal: null,
                target: urlPath("worker", "/src"),
                lineMarker: null,
                body: { target: urlPath("log", "/dst"), lineMarker: null },
                position: { line: 1, column: 1 },
            },
            workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.dev/engine/dispatcher/entry-operation-unsupported",
        );
        assert.equal(result.problem?.scheme, "log");
        assert.equal(result.problem?.category, "logging");
    } finally { await db.close(); }
});
