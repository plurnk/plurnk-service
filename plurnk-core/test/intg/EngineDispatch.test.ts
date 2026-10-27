import test, { describe } from "node:test";
import assert from "node:assert/strict";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryScheme from "./_entry-scheme.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import File from "../../src/schemes/File.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { type ParsedPath, type ReadStatement, type TextLineMarker, type EditStatement, type KillStatement, type NoteStatement, type MatcherBody, type UrlPath, type PlurnkStatement, type FindStatement } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type SchemeCtx } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, insertOperationTurn, seedEnvelope, insertLoop, insertTurn } from "./_db.ts";
import { readThroughScheme, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, sendStmt } from "./_dsl.ts";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { fixtureExecutors } from "./_mock.ts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { resourceGroups, resourcePaths } from "./_find.ts";


describe("Engine.dispatch", () => {
const dispatchEditStmt = (opts: { target: ParsedPath; body?: string | null; marker?: TextLineMarker | null; aside?: string | null }): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: opts.aside ?? null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: null, body: opts.body ?? null,
    position: { line: 1, column: 1 },
});

const readStmt = (opts: { target: ParsedPath; marker?: ReadStatement["lineMarker"] }): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const killStmt = (opts: { target: ParsedPath; marker?: TextLineMarker | null; matcher?: MatcherBody | null }): KillStatement => ({
    metadata: null,
    op: "KILL", aside: null,
    target: opts.target,
    lineMarker: opts.marker ?? null,
    matcher: opts.matcher ?? null, body: null,
    position: { line: 1, column: 1 },
});

const continuationStmt = (opts: { body?: string | null }): NoteStatement => ({
    metadata: null,
    op: "NOTE", aside: null,
    target: null,
    lineMarker: null,
    body: opts.body ?? "Continue the task.",
    position: { line: 1, column: 1 },
});

test("{§op-invariants} Engine.dispatch: KILL against workspace:/// permanently deletes the entry (200, then READ 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/obsolete/note"), body: "stale" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("workspace", "/obsolete/note") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200);
        const read = await engine.dispatch({
            statement: readStmt({ target: urlPath("workspace", "/obsolete/note") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(read.status, 404);
    } finally { await db.close(); }
});

test("{§scheme-address} namespace fixture://x and fixture:///x address the same entry", async () => {
    const { db, engine, env } = await setup();
    try {
        // create via the path form: fixture:///config.json => /config.json
        const created = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("fixture", "/config.json"), body: "host=db.internal" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        // Namespace authority is folded into its path, unlike a resource authority.
        const authForm: UrlPath = { kind: "url", raw: "fixture://config.json", scheme: "fixture", username: null, password: null, hostname: "config.json", port: null, pathname: "", query: null, fragment: null };
        const read = await engine.dispatch({
            statement: readStmt({ target: authForm }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(read.status, 200);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} Engine.dispatch: the KILL matcher survives into the log row's tx (even on a 404)", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: killStmt({ target: urlPath("workspace", "/gone"), matcher: { dialect: "glob", raw: "superseded — see /final" } }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("KILL log_entry not found");
        assert.equal(log.op, "KILL");
        const tx = JSON.parse(log.tx) as { matcher: MatcherBody | null; body: null };
        assert.deepEqual(tx.matcher, { dialect: "glob", raw: "superseded — see /final" });
        assert.equal(tx.body, null);
    } finally { await db.close(); }
});

test("{§slot-order}: the descriptive aside survives durable dispatch unchanged", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({
                target: urlPath("workspace", "/annotated"),
                body: "content",
                aside: "Create the shared note",
            }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{ tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("EDIT with an aside: log_entry not found");
        const tx = JSON.parse(log.tx) as { aside: unknown };
        assert.equal(tx.aside, "Create the shared note");
    } finally { await db.close(); }
});

test("{§log-history-projection} Engine.dispatch: KILL against a non-running exec:/// returns 404 (nothing to kill)", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("exec", "/sh/1/1/2") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(kill.status, 404);
    } finally { await db.close(); }
});

// {§log-history-projection}
test("{§log-history-projection} Engine.dispatch preserves log KILL's missing-coordinate failure", async () => {
    const { db, engine, env } = await setup();
    try {
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/0") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "_plurnk",
        });
        assert.equal(kill.status, 404, "a missing log coordinate remains not found");
    } finally { await db.close(); }
});

test("{§log-history-projection} model-origin log KILL atomically retires its target and preserves exact history", async () => {
    const { db, engine, env } = await setup();
    try {
        // A real model-origin row at coordinate /1/1/1 (loop seq 1, turn seq 1, sequence 1).
        const plan = await engine.dispatch({
            statement: continuationStmt({ body: "obsolete goals to curate away" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const kill = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 2, origin: "model",
        });
        assert.equal(kill.status, 200, "the model is authorized to retire its log item");
        assert.deepEqual(
            await db.test_get_log_projection.get({ session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 }),
            { id: 1, active: 0, folded: "[]" },
            "KILL changes projection state rather than deleting the event",
        );
        assert.deepEqual(
            await db.test_log_curation_effects_by_session.all({ session_id: env.sessionId }),
            [{
                operation_log_entry_id: 2,
                target_log_entry_id: 1,
                active_before: 1,
                active_after: 0,
                folded_before: "[]",
                folded_after: "[]",
                op: "KILL",
                turn_id: env.turnId,
                operation_sequence: 2,
                target_sequence: 1,
            }],
            "the KILL row and exact target transition land as one durable curation event",
        );
        assert.equal(
            await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: env.turnId }).then((row) => row?.n),
            2,
            "both the target event and KILL event remain in chronological history",
        );
        const gone = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 3, origin: "model",
        });
        assert.equal(gone.status, 404, "a killed exact coordinate is absent from the active address space");
    } finally { await db.close(); }
});

test("{§op-shapes} a NOTE retains its literal text and does not claim a lifecycle outcome", async () => {
    const { db, engine, env } = await setup();
    try {
        const plan = await engine.dispatch({
            statement: continuationStmt({ body: "The capital of France remains unverified." }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence: 1, origin: "model",
        });
        assert.equal(plan.status, 200);
        const log = await db.test_first_log_entry_for_turn.get<{ op: string; tx: string }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("NOTE log_entry not found");
        assert.equal(log.op, "NOTE");
        const tx = JSON.parse(log.tx) as { body: unknown };
        assert.equal(tx.body, "The capital of France remains unverified.");
    } finally { await db.close(); }
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    schemes.register("fixture", new EntryScheme());
    const engine = new Engine({ db, schemes });
    return { db, engine, env };
};

for (const op of ["READ", "FIND"] as const) {
    test(`{§diagnostic-observation}: ${op} without a path identifies the missing target, not a missing scheme`, async () => {
        const { db, engine, env } = await setup();
        try {
            const parsed = PlurnkParser.parse(`\`\`\`\`${op}\n*\n\`\`\`\``);
            const item = parsed.items.find((candidate) => candidate.kind === "statement" && candidate.statement.op === op);
            assert.ok(item?.kind === "statement");
            assert.ok(item.statement.op === "READ" || item.statement.op === "FIND");
            const result = await engine.dispatch({ statement: item.statement, ...env, sequence: 1, origin: "model" });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/target-required");
            assert.equal(result.problem?.detail, `${op} requires a target path.`);
            const local = await engine.dispatch({ statement: { ...item.statement, target: { kind: "local", raw: "example.txt" } }, ...env, sequence: 2, origin: "model" });
            assert.equal(local.status, 404, "the bare path reaches file resolution rather than missing-target refusal");
            assert.equal(local.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        } finally { await db.close(); }
    });
}

test("{§loop-completion}: retiring a failed receipt does not make it observed", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.injectIntoLoop(env.loopId, "Report the result.", [], undefined, {}, "message://request/result");
        await engine.runTurn({ ...env, messages: [], provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: "```NOTE\nInspect the result.\n```", reasoning: null,
        } }] }) });
        const { id: turnId } = await Turn.open(db, { loopId: env.loopId, producer: "model", kind: "inference" });
        const coordinates = await db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({ loop_id: env.loopId, turn_id: turnId });
        assert.ok(coordinates);
        const failed = await engine.dispatch({ ...env, turnId, sequence: 1, origin: "model",
            statement: readStmt({ target: urlPath("workspace", "/missing.md") }),
        });
        assert.equal(failed.status, 404);
        const result = await engine.executeAdmittedTurn({ ...env, turnId, fromSequence: 2, origin: "model",
            source: null, emission: null, statements: [
                killStmt({ target: urlPath("log", `/${coordinates.loop_seq}/${coordinates.turn_seq}/1/READ`) }),
                { ...sendStmt(null), metadata: ["200"] },
            ],
        });
        assert.equal(result.status, 102, "retiring the receipt cannot remove the observation barrier");
        assert.deepEqual(result.outcomes, [
            { op: "KILL", status: 200, problemType: null },
            { op: "SEND", status: 200, problemType: null },
        ], "curation and delivery succeed independently of continuation");
        const history = await db.test_log_entries_by_turn.all<{ op: string; origin: string; active: number; status_rx: number }>({ turn_id: turnId });
        const receipt = history.find(({ op, origin }) => op === "READ" && origin === "model");
        assert.equal(receipt?.active, 0, "the failed receipt was actually removed from the model's curated view");
        assert.equal(receipt?.status_rx, 404, "execution evidence retains the failure");
        assert.equal((await db.message_unanswered_count.get({ loop_id: env.loopId }))?.count, 0,
            "the failed result, not an unanswered or unpublished message, prevents settlement");
        assert.equal((await engine.runTurn({ ...env, messages: [], provider: new Mock({ contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null } }],
        }) })).status, 200);
    } finally { await db.close(); }
});

test("{§packet} a KILL line scope trims a NOTE like any other log body", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: continuationStmt({ body: "Verify the finding.\nThe finished action.\nThe open inquiry." }),
            ...env, sequence: 1, origin: "model",
        });
        const curated = await engine.dispatch({
            statement: killStmt({ target: urlPath("log", "/1/1/1/NOTE"), marker: { marks: [2, 2] } }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(curated.status, 200);
        const row = await db.test_get_log_folded.get<{ folded: string }>({
            session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(row?.folded, "[[2,2]]", "the completed entry's line is suppressed; lines 1 and 3 stay visible");
    } finally { await db.close(); }
});
test("{§edit} Engine.dispatch: EDIT against workspace:/// routes to Session.edit, returns 201, writes entry", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/france/capital"), body: "Paris" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201);
        const entryId = (result as unknown as { entryId: number }).entryId;
        assert.ok(entryId >= 1);
        const entry = await db.test_get_entry_by_id.get<{ pathname: string }>({ id: entryId });
        assert.equal(entry?.pathname, "/france/capital");
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: a current READ line anchor lowers to a numeric EDIT precondition", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/anchored.md");
    const identity = "workspace:///anchored.md";
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: "alpha\nbeta\ngamma" }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);

        const original = "alpha\nbeta\ngamma";
        const beta = LineAnchors.token(identity, 2, original);
        const gamma = LineAnchors.token(identity, 3, original);
        const edited = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [beta] }, body: "BETA" }),
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
            statement: dispatchEditStmt({ target, marker: { marks: [gamma] }, body: "GAMMA" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, "EDIT collided with the current resource state."); // {§operation-results}
        assert.equal(stale.problem?.target, identity);
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} Engine.dispatch: an EDIT anchor offset applies the splice of the numeric line it names (#749)", async () => {
    const { db, engine, env } = await setup();
    const original = "alpha\nbeta\ngamma\ndelta";
    try {
        const contents: string[] = [];
        let sequence = 0;
        for (const [name, marks] of [["offset", (identity: string) => [`${LineAnchors.token(identity, 2, original)}+1`]], ["numeric", () => [3]]] as const) {
            const target = urlPath("workspace", `/${name}.md`);
            const identity = `workspace:///${name}.md`;
            assert.equal((await engine.dispatch({ statement: dispatchEditStmt({ target, body: original }), ...env, sequence: ++sequence, origin: "model" })).status, 201);
            const edited = await engine.dispatch({ statement: dispatchEditStmt({ target, marker: { marks: marks(identity) as [number | string] }, body: "GAMMA" }), ...env, sequence: ++sequence, origin: "model" });
            assert.equal(edited.status, 200, name);
            const read = await engine.dispatch({ statement: readStmt({ target }), ...env, sequence: ++sequence, origin: "model" });
            contents.push((read as { content?: string }).content ?? "");
        }
        assert.equal(contents[0], "alpha\nbeta\nGAMMA\ndelta");
        assert.equal(contents[0], contents[1]);
    } finally { await db.close(); }
});

test("{§read} Engine.dispatch: a READ range starting past the end is an empty page with its extent; a single line past it is still refused (#759)", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/thirteen.md");
    try {
        const content = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
        assert.equal((await engine.dispatch({ statement: dispatchEditStmt({ target, body: content }), ...env, sequence: 1, origin: "model" })).status, 201);
        let sequence = 1;
        for (const marks of [[90, -1], [85, 210], [14, -1]] as const) {
            const read = await engine.dispatch({ statement: readStmt({ target, marker: { marks: [...marks] } }), ...env, sequence: ++sequence, origin: "model" });
            assert.ok(read.status === 200 || read.status === 204, JSON.stringify(marks));
            assert.equal((read as { content?: string }).content ?? "", "", JSON.stringify(marks));
            assert.deepEqual((read as { range?: unknown }).range, { unit: "line", total: 13, requested: [...marks] }, JSON.stringify(marks));
        }
        for (const marks of [[90], [5, 3], [90, 50]] as const) {
            const refused = await engine.dispatch({ statement: readStmt({ target, marker: { marks: [...marks] } }), ...env, sequence: ++sequence, origin: "model" });
            assert.equal(refused.status, 416, JSON.stringify(marks));
        }
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: an EDIT anchor in a column slot names the accepted whole-line range", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/invalid-anchor-region.md");
    const identity = "workspace:///invalid-anchor-region.md";
    try {
        const content = "alpha\nbeta\ngamma";
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: content }),
            ...env, sequence: 1, origin: "model",
        })).status, 201);
        const first = LineAnchors.token(identity, 1, content);
        const third = LineAnchors.token(identity, 3, content);

        const invalid = await engine.dispatch({
            statement: dispatchEditStmt({
                target,
                marker: { marks: [first, third, first, third] },
                body: null,
            }),
            ...env, sequence: 2, origin: "model",
        });
        assert.equal(invalid.status, 400);
        assert.equal(
            invalid.problem?.detail,
            "A line anchor occupies a column slot in <SL,SC,EL,EC>; columns must be numeric.",
        );
        assert.equal(
            invalid.problem?.recovery,
            "Use <@start,@end> for an inclusive whole-line anchor range.",
        );
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: READ accepts a current line anchor and rejects a stale one as a collision", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/anchor-read.md");
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: "alpha\nbeta\ngamma" }),
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
            statement: dispatchEditStmt({ target, marker: { marks: [2] }, body: "BETA" }),
            ...env, sequence: 4, origin: "model",
        })).status, 200);
        const stale = await engine.dispatch({
            statement: readStmt({ target, marker: { marks: [anchor!] } }),
            ...env, sequence: 5, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/line-anchor-collision");
        assert.equal(stale.problem?.retryable, false, "stale coordinates require a new READ, not automatic replay");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§log-kill-scope} Engine.dispatch: scoped KILL accepts body and log anchors, and READ respects the curated view", async () => {
    const { db, engine, env } = await setup();
    const content = "alpha\nbeta\ngamma";
    const target = urlPath("log", "/1/1/1/READ");
    const publishedAnchors = LineAnchors.tokens("workspace:///source.md", content);
    try {
        await db.engine_insert_log_entry.get({
            session_id: env.sessionId, loop_id: env.loopId, turn_id: env.turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "READ",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/source.md", query: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/plain",
            rx: JSON.stringify({
                status: 200,
                content,
                mimetype: "text/plain",
                startLine: 17,
                lineAnchorIdentity: "workspace:///source.md",
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
            statement: killStmt({ target, marker: { marks: [publishedAnchors[1]] } }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(foldedFromBody.status, 200);
        const foldedFromLogRead = await engine.dispatch({
            statement: killStmt({ target, marker: { marks: [logAnchors[2]] } }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(foldedFromLogRead.status, 200);
        const row = await db.test_get_log_folded.get<{ folded: string }>({
            session_id: env.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1,
        });
        assert.equal(row?.folded, "[[2,3]]");

        const recovered = await engine.dispatch({
            statement: readStmt({ target }),
            ...env, sequence: 5, origin: "model",
        });
        assert.equal(recovered.status, 200);
        assert.equal((recovered as { content?: string }).content, "alpha", "READ omits deliberately trimmed lines");
        const rows = await db.test_log_entries_by_turn.all<{
            sequence: number;
            op: string | null;
            active: 0 | 1;
            folded: string;
            rx: string;
        }>({ turn_id: env.turnId });
        const retrieval = rows.find(({ sequence }) => sequence === 5);
        assert.deepEqual(
            { op: retrieval?.op, active: retrieval?.active, folded: retrieval?.folded },
            { op: "READ", active: 1, folded: "[]" },
            "retrieval lands as a new visible READ occurrence instead of mutating the curated occurrence",
        );
        assert.equal((JSON.parse(retrieval?.rx ?? "null") as { content?: string }).content, "alpha");
        assert.equal(JSON.parse(rows.find(({ sequence }) => sequence === 1)!.rx).content, content, "scoped curation preserves the complete original receipt for forensics");
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: a scoped READ anchor includes nearby lines outside the returned slice", async () => {
    const { db, engine, env } = await setup();
    const target = urlPath("workspace", "/contextual-anchor.md");
    const content = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    try {
        assert.equal((await engine.dispatch({
            statement: dispatchEditStmt({ target, body: content }),
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
            statement: dispatchEditStmt({ target, marker: { marks: [7] }, body: "changed-nearby" }),
            ...env, sequence: 3, origin: "model",
        })).status, 200);

        const stale = await engine.dispatch({
            statement: dispatchEditStmt({ target, marker: { marks: [anchor!] }, body: "changed-target" }),
            ...env, sequence: 4, origin: "model",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(stale.problem?.detail, "EDIT collided with the current resource state."); // {§operation-results}
        assert.equal(stale.problem?.target, "workspace:///contextual-anchor.md");
        assert.equal(stale.problem?.anchor, undefined);
    } finally { await db.close(); }
});

test("{§scheme-operation-dispatch} Engine.dispatch: a mutation between anchor resolution and landing is an edit collision", async () => {
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
                            content: "alpha\nother session\ngamma",
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
            statement: dispatchEditStmt({ target, body: original }),
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
            statement: dispatchEditStmt({ target, marker: { marks: [anchor] }, body: "authored edit" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(collided.status, 409);
        assert.equal(collided.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(collided.problem?.detail, "EDIT collided with the current resource state."); // {§operation-results}
        assert.equal(collided.problem?.target, identity);
        assert.equal(collided.problem?.anchor, undefined);

        const stored = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/unit.md",
            scheme: "racy",
            name: "body",
        });
        assert.equal(stored?.content, "alpha\nother session\ngamma");
    } finally { await db.close(); }
});

test("{§line-anchors} Engine.dispatch: an anchored EDIT retains the READ owner's canonical resource identity", async () => {
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
            return { authority: "", pathname: "/canonical.md" };
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
            statement: dispatchEditStmt({ target: alias, body: "alpha\nbeta\ngamma" }),
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
            statement: dispatchEditStmt({ target: alias, marker: { marks: [anchor] }, body: "BETA" }),
            ...env, sequence: 3, origin: "model",
        });
        assert.equal(edited.status, 200);
    } finally { await db.close(); }
});

test("{§edit} Engine.dispatch: a scheme without textual EDIT scopes rejects an anchor before invocation", async () => {
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
            statement: dispatchEditStmt({
                target: urlPath("whole", "/unit"),
                marker: { marks: ["@aZ09b"] },
                body: "replacement",
            }),
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/line-anchor-unsupported");
        assert.equal(invoked, false);
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} Engine.dispatch: writes log_entry with statement + result fields", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const log = await db.test_first_log_entry_for_turn.get<{
            session_id: number; loop_id: number; turn_id: number; sequence: number;
            origin: string; op: string; signal: string | null;
            scheme: string | null; pathname: string | null;
            tx: string; mimetype_tx: string; rx: string; mimetype_rx: string; status_rx: number;
        }>({ turn_id: env.turnId });
        if (log === undefined) throw new Error("log_entry not found");
        assert.equal(log.session_id, env.sessionId);
        assert.equal(log.loop_id, env.loopId);
        assert.equal(log.turn_id, env.turnId);
        assert.equal(log.sequence, 1);
        assert.equal(log.origin, "model");
        assert.equal(log.op, "EDIT");
        assert.equal(Object.hasOwn(log, "delimiter"), false);
        assert.equal(log.signal, null);
        assert.equal(log.scheme, "workspace");
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

test("{§scheme-surface} Engine.dispatch: READ against workspace:/// routes to Session.read", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/r"), body: "value" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("workspace", "/r") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal((result as unknown as { content: string }).content, "value");
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: unknown scheme returns 501 and still writes log row", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("wiki", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 501);
        assert.equal(log?.scheme, "wiki");
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: null path on path-required op returns 400 and logs", async () => {
    const { db, engine, env } = await setup();
    try {
        const stmt: EditStatement = {
            metadata: null,
            op: "EDIT", aside: null, target: null, lineMarker: null, matcher: null, body: "y",
            position: { line: 1, column: 1 },
        };
        const result = await engine.dispatch({
            statement: stmt,
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string | null; pathname: string | null }>({ turn_id: env.turnId });
        assert.equal(log?.status_rx, 400);
        assert.equal(log?.scheme, null);
        assert.equal(log?.pathname, null);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} Engine.dispatch: multiple actions in one turn — log_entries sequence UNIQUE enforced", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/a"), body: "1" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/b"), body: "2" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
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
test("{§scheme-surface} Engine.dispatch: origin field captured in log", async () => {
    const { db, engine, env } = await setup();
    try {
        const turnIds: number[] = [];
        for (const [i, origin] of (["model", "client", "_plurnk"] as const).entries()) {
            const turnId = origin === "model"
                ? env.turnId
                : await insertOperationTurn(db, env.loopId, i + 1, origin);
            turnIds.push(turnId);
            await engine.dispatch({
                statement: dispatchEditStmt({ target: urlPath("workspace", `/o${i}`), body: "x" }),
                workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId,
                sequence: 1, origin,
            });
        }
        const origins = [];
        for (const turnId of turnIds) {
            const rows = await db.test_log_entries_by_turn.all<{ origin: string }>({ turn_id: turnId });
            origins.push(rows[0]?.origin);
        }
        assert.deepEqual(origins, ["model", "client", "_plurnk"]);
    } finally { await db.close(); }
});

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy or dispatch
// returns 403 without invoking the handler.

test("{§scheme-surface} Engine.dispatch: a writer outside writableBy is rejected 403 without invoking the handler", async () => {
    const { db, engine, env } = await setup();
    try {
        const turnId = await insertOperationTurn(db, env.loopId, 2, "client");
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("reasoning", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId,
            sequence: 1, origin: "client",
        });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
        assert.equal(result.problem?.writer, "client");
        assert.equal(result.problem?.scheme, "reasoning");
        assert.deepEqual(result.problem?.allowedWriters, []);
        // 403 still writes a log row
        const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number; scheme: string }>({ turn_id: turnId });
        assert.equal(log?.status_rx, 403);
        assert.equal(log?.scheme, "reasoning");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: log EDIT has no mutation surface; reasoning uses an ordinary data resource", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        assert.match(result.problem!.type, /operation-not-implemented$/);
        assert.equal(result.problem!.detail, "Scheme 'log' does not implement EDIT."); // {§operation-results}
    } finally { await db.close(); }
});

test("{§turn-source-resources} Engine.dispatch: model EDIT of reasoning is rejected with 403 (turn sources are immutable)", async () => {
    const { db, engine, env } = await setup();
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: { ...urlPath("reasoning", "/1/1"), hostname: "alice", raw: "reasoning://alice/1/1" }, body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    } finally { await db.close(); }
});

test("{§session-scheme} Engine.dispatch: an unrelated model writes named runtime scratch through ordinary EDIT", async () => {
    const { db, engine, env } = await setup();
    try {
        await RuntimeSession.ensure(db, env.workspaceId);
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: { kind: "url", raw: "session://_plurnk/private.md", scheme: "session", username: null, password: null, hostname: "_plurnk", port: null, pathname: "/private.md", query: null, fragment: null }, body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 201, "runtime scratch has the same workspace access as any named scratch");
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: model READ log:/// is NOT gated by writableBy (read-side op)", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log scheme has no read() handler yet, so this returns 501 — proves
        // the writableBy gate did NOT intercept (would have returned 403).
        const result = await engine.dispatch({
            statement: readStmt({ target: urlPath("log", "/x") }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: _plurnk EDIT log:/// is allowed by writableBy", async () => {
    const { db, engine, env } = await setup();
    try {
        // Log has no edit() handler — so this returns 501 (not 403) when allowed.
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("log", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "_plurnk",
        });
        assert.notEqual(result.status, 403);
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: an instance manifest enforces writableBy like a static manifest", async () => {
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
                writableBy: [],
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
            statement: dispatchEditStmt({ target: urlPath("dynamic", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
        assert.equal(invoked, false, "the handler is not invoked after its manifest denies the writer");
    } finally { await db.close(); }
});

test("{§scheme-surface} Engine.dispatch: a model reply needs no external capability", async () => {
    const { db, engine, env } = await setup();
    try {
        await engine.injectIntoLoop(env.loopId, "Reply.", [], undefined, {}, "message://request/reply");
        const result = await engine.dispatch({
            statement: sendStmt(parsePath("message://request/reply")),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// {§scheme-surface} Scheme-handler
// exceptions finalize the action-entry at 500, not bubble up.

test("{§operation-results} Engine.dispatch: scheme handler that throws → action-entry at status 500 (action-entry-as-outcome)", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    class Boom {
        static manifest = {
            name: "boom", channels: {}, defaultChannel: "",
            category: "data" as const,
            writableBy: ["model" as const], volatile: false, modelVisible: true,
        };
        async editBatch(): Promise<never> { throw new Error("scheme handler deliberately threw"); }
    }
    schemes.register("boom", new Boom());
    const engine = new Engine({ db, schemes });
    try {
        const result = await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("boom", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.detail, "The 'boom' scheme did not produce a result for EDIT."); // {§operation-results}
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
        assert.equal(rx.problem.detail, "The 'boom' scheme did not produce a result for EDIT."); // {§operation-results}
        assert.doesNotMatch(log?.rx ?? "", /scheme handler deliberately threw/);
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: non-Error throw becomes the same generic contract Problem", async () => {
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
            statement: dispatchEditStmt({ target: urlPath("boomstr", "/x"), body: "y" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw");
        assert.equal(result.problem?.detail, "The 'boomstr' scheme did not produce a result for EDIT."); // {§operation-results}
        assert.doesNotMatch(JSON.stringify(result), /raw string thrown/);
    } finally { await db.close(); }
});

test("{§operation-results} Engine.dispatch: COPY rejects a non-entry destination at resource resolution", async () => {
    const { db, engine, env } = await setup();
    try {
        // Source first: model creates an entry in workspace:///.
        await engine.dispatch({
            statement: dispatchEditStmt({ target: urlPath("workspace", "/src"), body: "v" }),
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 1, origin: "model",
        });
        // Attempt copy workspace:///src → log:///dst — destination scheme rejects.
        const result = await engine.dispatch({
            statement: {
                op: "COPY", aside: null,
                source: { target: urlPath("workspace", "/src"), metadata: null, lineMarker: null, matcher: null },
                destination: { target: urlPath("log", "/dst"), metadata: null, lineMarker: null, matcher: null },
                position: { line: 1, column: 1 },
            },
            workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId,
            sequence: 2, origin: "model",
        });
        assert.equal(result.status, 400);
        assert.equal(
            result.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/entry-operation-unsupported",
        );
        assert.equal(result.problem?.scheme, "log");
        assert.equal(result.problem?.category, "logging");
    } finally { await db.close(); }
});
});


describe("op-uri-contract", () => {
// Operation semantics coverage matrix: how each entry op resolves a model-typed path and how
// matchers render.
//
// {§fs-namespace} Every operation resolves filesystem spellings to project-relative keys.

















const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    readThroughScheme("file", null, statement, ctx);

// Parse one op the way production does, so a bare path carries its REAL parsed shape
// (LocalPath {kind:"local"}) — the exact thing the model emits, not a hand-built UrlPath.
const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find((i) => i.kind === "statement" && i.statement.op === op);
    if (found === undefined) throw new Error(`no ${op} parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: T }).statement;
};

// Materialize a file as a readable member — mirrors the git-membership pass: disk
// content into the entry's body channel under its project-relative key.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await ctx.db.envelope_get_workspace.get<{ project_root: string }>({ id: ctx.workspaceId });
    assert.ok(row?.project_root);
    await MembershipMaterialization.materializeMember(pathname, row.project_root, ctx, new Map());
};

const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-uri-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `uri-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// ── Path resolution: every op normalizes a bare model path to the canonical member key ──

// CELL [FIND × bare local path]. The member is stored `/notes.md`; the model FINDs
// `notes.md`. FIND must canonicalize and select the member — exactly as READ does.
test("{§fs-namespace} contract: FIND(bare path) resolves the canonical-stored member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("````FIND (notes.md)````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200, "FIND succeeds");
        assert.ok(resourcePaths(result).includes("notes.md"), `FIND must find the member (catalog renders it bare: notes.md); got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

// CONTROL [READ × bare local path]. Same condition — proves the harness reproduces the real path.
test("{§fs-namespace} contract: READ(bare path) resolves the canonical-stored member (control)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<ReadStatement>("````READ (notes.md)````", "READ");
        const result = await readFileScheme(stmt, ctx);
        assert.equal(result.status, 200, "READ canonicalizes the bare path and resolves the member");
        assert.match(result.content ?? "", /phoenix/, "READ returns the member content");
    });
});

// CONTROL [EDIT × bare local path]. EDIT canonicalizes (#resolveTarget) — a bare
// path resolves to the member and proposes (202).
test("{§edit} contract: EDIT(bare path) resolves the canonical-stored member and proposes (control)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        // {§edit} — notes.md already exists; <1,-1> states the rewrite.
        const stmt = parseOp<ResolvedEditStatement>("````EDIT (notes.md) <1,-1>\nthe codename is dragon\n````", "EDIT");
        const result = await new File().edit(stmt, ctx);
        assert.equal(result.status, 202, `EDIT canonicalizes the bare path → proposal; got ${result.status} ${result.problem?.detail ?? ""}`);
    });
});

test("{§fs-namespace} FIND of an absolute path resolves the member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "the codename is phoenix\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>(PlurnkParser.frame(`FIND (${join(root, "notes.md")})`, null), "FIND");
        const result = await new File().find(stmt, ctx);
        assert.ok(resourcePaths(result).includes("notes.md"), `the leading-slash form finds it; got: ${JSON.stringify(resourcePaths(result))}`);
    });
});

// {§find-result-projection}: exact matcher FIND exposes navigation locations.

test("{§fs-namespace} an exact regex FIND returns its flat match location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "heading\nthe codename is phoenix\ncontext\n");
        await addMember(ctx, "notes.md");
        const stmt = parseOp<FindStatement>("````FIND (notes.md) /phoenix/````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("{§fs-namespace} contract: an exact FIND returns every match as a flat location", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "log.md"), "alpha\ntarget one\nbeta\ngamma\ntarget two\n");
        await addMember(ctx, "log.md");
        const stmt = parseOp<FindStatement>("````FIND (log.md) *target*````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

test("{§path-syntax} contract: an exact jsonpath FIND returns flat structural locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "config.json"), '{\n  "host": "db.internal",\n  "pool": 5\n}\n');
        await addMember(ctx, "config.json");
        const stmt = parseOp<FindStatement>("````FIND (config.json) $.host````", "FIND");
        const result = await new File().find(stmt, ctx);
        assert.equal(result.status, 200);
        assert.ok(result.results.length > 0);
    });
});

// CELL [FIND × file scheme glob] — the recursive tracked-file list. Confirm the explicit
// file URI and bare project-relative form expose the same view ({§path-syntax}).
test("{§fs-namespace} explicit file URI and bare FIND globs list the same members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "a.md"), "alpha");
        await mkdir(join(root, "docs"), { recursive: true });
        await writeFile(join(root, "docs/b.md"), "beta");
        await addMember(ctx, "a.md");
        await addMember(ctx, "docs/b.md");
        for (const dsl of [PlurnkParser.frame(`FIND (file://${root}/**)`, null), "````FIND (**)````"]) {
            const r = await new File().find(parseOp<FindStatement>(dsl, "FIND"), ctx);
            assert.equal(r.status, 200, `${dsl} → 200`);
            assert.equal(r.results.length, 2, `${dsl} lists both tracked members`);
            const paths = resourcePaths(r).join(" ");
            assert.match(paths, /a\.md/, `${dsl} includes a.md`);
            assert.match(paths, /b\.md/, `${dsl} includes docs/b.md`);
        }
    });
});

test("{§fs-namespace} contract: bare FIND(*) is a shallow project map; FIND(**) is recursive", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, ".env.defaults"), "defaults");
        await mkdir(join(root, ".github"), { recursive: true });
        await writeFile(join(root, ".github/settings.yml"), "settings");
        await writeFile(join(root, "README.md"), "root");
        await mkdir(join(root, "src", "nested"), { recursive: true });
        await writeFile(join(root, "src/index.ts"), "direct");
        await writeFile(join(root, "src/nested/deep.ts"), "deep");
        for (const path of [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]) await addMember(ctx, path);

        const shallow = await new File().find(parseOp<FindStatement>("````FIND (*)````", "FIND"), ctx);
        assert.deepEqual(resourcePaths(shallow), [".env.defaults", ".github/**", "README.md", "src/**"]);
        const scope = resourceGroups(shallow).find(([item]) => item.path === "src/**")?.[0];
        assert.ok(scope !== undefined && "items" in scope);
        assert.equal(scope.items, 2);

        const recursive = await new File().find(parseOp<FindStatement>("````FIND (**)````", "FIND"), ctx);
        assert.deepEqual(resourcePaths(recursive), [".env.defaults", ".github/settings.yml", "README.md", "src/index.ts", "src/nested/deep.ts"]);
    });
});

test("{§fs-namespace} directory and glob searches from filesystem ancestors retain only workspace members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/a.ts"), "a");
        await addMember(ctx, "src/a.ts");

        await writeFile(join(root, "hidden.txt"), "not a member");
        for (const target of [".", root, `${root}/`, "file:///", "/", "../", "../../**", `${root}/../**/*.ts`]) {
            const result = await new File().find(parseOp<FindStatement>(PlurnkParser.frame(`FIND (${target})`, null), "FIND"), ctx);
            assert.equal(result.status, 200, target);
            assert.deepEqual(resourcePaths(result), ["src/a.ts"], target);
        }
    });
});
});

