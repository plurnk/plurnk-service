import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `range-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Read the requested range and report it.");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId };
};

for (const channel of ["content", "reasoning"] as const) {
    for (const [scope, end] of [["<395,12>", 406], ["<395,+12>", 407]] as const) {
        test(`{§scope-range-recovery} ${channel} READ ${scope} returns the exact lines, preserves source and warns without a strike`, async (t) => {
            const { db, engine, ...context } = await setup();
            t.after(() => db.close());
            const lines = Array.from({ length: 410 }, (_, i) => `line ${i + 1}`);
            await seedEntryWithChannel(db, { workspaceId: context.workspaceId, pathname: "/range.txt", content: lines.join("\n") });
            const emission = PlurnkParser.frame(`READ (worker:///range.txt) ${scope}`, null);
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: "", reasoning: null, [channel]: emission } },
                { assistant: { content: PlurnkParser.frame("SEND [200]", "done"), reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            const second = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102);
            assert.equal(second.status, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
            const read = logEntries(packet).find((row) => row.path === "worker:///range.txt");
            const shown = String(read?.body).split("\n").filter(Boolean).map((line) => line.replace(/^\s*\d+<@[0-9A-Za-z]{5}>/u, ""));
            assert.deepEqual(shown, lines.slice(394, end));
            const notice = packetSection(packet, "notices");
            assert.ok(notice.includes(`Scope ${scope} was read as <395,${end}>.`), notice);
            assert.equal(notice.split("\n").filter((line) => line.includes("Scope ")).length, 1);
            assert.doesNotMatch(notice, /strike|no_operation|No valid Operation/u);
            const outcomes = await db.test_log_entries_by_turn.all<{ op: string; pathname: string; status_rx: number }>({ turn_id: first.turnId });
            assert.deepEqual(outcomes.filter(({ op, pathname }) => op === "READ" && pathname === "/range.txt").map(({ status_rx }) => status_rx), [200]);
            assert.ok(outcomes.every(({ status_rx }) => status_rx < 400), JSON.stringify(outcomes));
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: context.workerId });
            assert.ok(sources.some(({ turn_id, kind, content }) => turn_id === first.turnId && kind === (channel === "content" ? "ops" : "reasoning") && content === emission),
                "normalization must not rewrite the forensic emission");
        });
    }
}

test("{§scope-range-recovery} FIND selects positions and anchor inversions remain real range errors", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const context = await seedEnvelope(db, `range-boundaries-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const content = "one\ntwo\nthree\nfour\nfive";
    await seedEntryWithChannel(db, { workspaceId: context.workspaceId, pathname: "/range.txt", content });
    let sequence = 0;
    const dispatch = (header: string) => {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(header, null));
        const [statement] = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.ok(statement, JSON.stringify(parsed));
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
        return engine.dispatch({ ...context, statement, sequence: ++sequence, origin: "model" });
    };
    for (const scope of ["<3,2>", "<3,+1>"]) {
        const found = await dispatch(`FIND (worker:///range.txt) ${scope} /.+/`);
        assert.equal(found.status, 200, JSON.stringify(found));
        const matches = JSON.parse(String(found.content)) as { region: { startLine: number } }[];
        assert.deepEqual(matches.map(({ region }) => region.startLine), [3, 4], JSON.stringify(found));
    }
    const read = await dispatch("READ (worker:///range.txt) <1,-1>");
    assert.equal(read.status, 200);
    const anchors = read.lineAnchors as string[];
    assert.equal(anchors.length, 5);
    for (const scope of [`<${anchors[3]},${anchors[1]}>`, "<4,1,2,1>", "<3.5,2>"]) {
        const refused = await dispatch(`READ (worker:///range.txt) ${scope}`);
        assert.equal(refused.status, 416, JSON.stringify(refused));
        assert.match(String(refused.problem?.type), /\/range-not-satisfiable$/u);
    }
    const relative = await dispatch(`READ (worker:///range.txt) <${anchors[2]},+1>`);
    assert.equal(relative.status, 200);
    assert.equal(relative.content, "three\nfour");
    const pastEnd = await dispatch("READ (worker:///range.txt) <9,2>");
    assert.equal(pastEnd.status, 204);
    assert.equal(pastEnd.content, "", "a recovered range past EOF is the usual empty page");
    assert.deepEqual(pastEnd.range, { unit: "line", total: 5, requested: [9, 10] });
    assert.equal((await dispatch("READ (worker:///range.txt) <4,3>")).content, "four\nfive", "recovered counts use ordinary end clamping");
    assert.equal((await dispatch("READ (worker:///range.txt) <3,20>")).content, "three\nfour\nfive", "ordinary end clamping remains intact");
});

for (const scope of ["<3,2>", "<3,+1>"]) {
    test(`{§scope-range-recovery} EDIT, COPY, MOVE and KILL execute ${scope} through the same canonical range`, async (t) => {
        const { db, engine, ...context } = await setup();
        t.after(() => db.close());
        const seed = (name: string, content = "one\ntwo\nthree\nfour\nfive") => seedEntryWithChannel(db, { workspaceId: context.workspaceId, pathname: `/${name}`, content });
        for (const name of ["edited", "copied-from", "moved-from", "killed"]) await seed(name);
        for (const name of ["copied-to", "moved-to"]) await seed(name, "A\nB\nC\nD\nE");
        const program = [
            PlurnkParser.frame(`EDIT (worker:///edited) ${scope}`, "replacement"),
            PlurnkParser.frame(`COPY (worker:///copied-from) ${scope} (worker:///copied-to) ${scope}`, null),
            PlurnkParser.frame(`MOVE (worker:///moved-from) ${scope} (worker:///moved-to) ${scope}`, null),
            PlurnkParser.frame(`KILL (worker:///killed) ${scope}`, null),
        ].join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: program, reasoning: null } }] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        const outcomes = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(outcomes.filter(({ op }) => ["EDIT", "COPY", "MOVE", "KILL"].includes(op)).map(({ op, status_rx }) => ({ op, status_rx })), [
            { op: "EDIT", status_rx: 200 }, { op: "COPY", status_rx: 200 }, { op: "MOVE", status_rx: 200 }, { op: "KILL", status_rx: 200 },
        ]);
        const body = async (name: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: `/${name}`, name: "body" }))?.content;
        assert.equal(await body("edited"), "one\ntwo\nreplacement\nfive");
        assert.equal(await body("copied-from"), "one\ntwo\nthree\nfour\nfive");
        assert.equal(await body("copied-to"), "A\nB\nthree\nfour\nE");
        assert.equal(await body("moved-from"), "one\ntwo\nfive");
        assert.equal(await body("moved-to"), "A\nB\nthree\nfour\nE");
        assert.equal(await body("killed"), "one\ntwo\nfive");
    });
}
