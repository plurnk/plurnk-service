import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import { GeneratedByteSource, Results, type ResourceTree, type ResourceTreeRegistrationSeam, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { TEST_OWNER } from "./_approval.ts";
import { copyStmt, editStmt, findStmt, killStmt, readStmt, regex } from "./_dsl.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

test("{§resource-tree-scheme} a public module supplies live trees while the host owns projection, selection and withdrawal", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const files = new Map<string, string | Uint8Array>([
        ["guide.txt", "one\nneedle\nthree"],
        ["nested/child.txt", "nested source"],
        ["bytes.txt", Buffer.from([0, 255, 128])],
    ]);
    const trees = new Map<string, ResourceTree>([["alpha", {
        list: async () => [...files.keys()],
        resource: (name) => new GeneratedByteSource(async () => {
            const value = files.get(name);
            return typeof value === "string" ? new TextEncoder().encode(value) : value ?? null;
        }),
    }], ["beta", {
        list: async () => ["guide.txt"],
        resource: (name) => new GeneratedByteSource(async () => name === "guide.txt" ? new TextEncoder().encode("other tree") : null),
    }]]);
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", { trees: () => trees });
    } }, "@acme/catalog");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-witness" });
    const dispatch = async (statement: PlurnkStatement) =>
        (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
    const find = async (path: string, matcher: ReturnType<typeof regex> | null = null) => {
        const result = await dispatch({ ...findStmt(parsePath(path), matcher), lineMarker: { marks: [1, -1] } });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.ok(Array.isArray(result.results));
        return (result.results.flat() as Array<{ path: string }>).map((item) => item.path);
    };
    assert.deepEqual(await find("catalog://*/guide.txt", regex("needle")), ["catalog://alpha/guide.txt"]);
    assert.deepEqual(await find("catalog://alpha/*"), ["catalog://alpha/bytes.txt", "catalog://alpha/guide.txt", "catalog://alpha/nested/**"]);
    const guide = parsePath("catalog://alpha/guide.txt");
    assert.equal((await dispatch(readStmt(guide, { marks: [2, 2] }))).content, "needle");
    const binary = await dispatch(readStmt(parsePath("catalog://alpha/bytes.txt"), { marks: [1, -1] }));
    assert.equal(binary.status, 200);
    assert.equal(binary.content, "00\nff\n80", "binary sniffing and byte projection belong to the host");
    const copied = await dispatch(copyStmt(guide!, parsePath("workspace:///copied.txt")!, { marks: [2, 2] }));
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal((await dispatch(readStmt(parsePath("workspace:///copied.txt")))).content, "needle\n", "COPY preserves the selected source line's terminator");
    for (const statement of [editStmt(guide, "changed", { marks: [1, -1] }), killStmt(guide)]) {
        assert.equal((await dispatch(statement)).status, 403, "tree projections cannot mutate their sources");
    }
    files.set("guide.txt", "fresh text");
    assert.equal((await dispatch(readStmt(guide))).content, "fresh text");
    files.delete("guide.txt");
    assert.equal((await dispatch(readStmt(guide))).status, 404, "cached content is not a missing source");
    trees.delete("beta");
    assert.deepEqual(await find("catalog://*/**"), ["catalog://alpha/bytes.txt", "catalog://alpha/nested/child.txt"]);
});

test("{§resource-tree-scheme} projection failures cannot become source refusals or stale content", async (t) => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes();
    const daemon = new Daemon({ db, provider: null, mimetypes });
    t.after(async () => { await daemon.stop(); await mimetypes.dispose(); await db.close(); });
    let translations = 0;
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", {
            trees: () => new Map([["alpha", {
                list: async () => ["image.png"],
                resource: () => new GeneratedByteSource(async () => Buffer.from([0, 1, 2])),
            }]]),
            refusal: () => {
                translations++;
                return Results.failure("scheme:catalog", "entry-not-found", 404, "Missing source.");
            },
        });
    } }, "@acme/catalog");
    await daemon.start();
    t.mock.method(mimetypes, "projectReadableStream", async () => { throw Object.assign(new Error("projection failed"), { code: "ENOENT" }); });
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-projection" });
    for (const statement of [readStmt(parsePath("catalog://alpha/image.png")), findStmt(parsePath("catalog://alpha/**"))]) {
        const [result] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }) as SchemeResult[];
        assert.equal(result.status, 500);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw");
    }
    assert.equal(translations, 0, "the source does not classify another owner's errors");
});

test("{§resource-tree-scheme} recognized source failures retain their result through exact and collection reads", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    const failure = new Error("source refused");
    daemon.registerModule({ async setup(seam: ResourceTreeRegistrationSeam) {
        await seam.registerResourceTreeScheme("catalog", {
            trees: () => new Map([["refused", {
                list: async () => { throw failure; },
                resource: () => new GeneratedByteSource(async () => { throw failure; }),
            }]]),
            refusal: (cause) => cause === failure
                ? Results.failure("scheme:catalog", "resource-outside-root", 403, "The source is outside its tree.")
                : null,
        });
    } }, "@acme/catalog");
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "resource-tree-failure" });
    for (const statement of [readStmt(parsePath("catalog://refused/item")), findStmt(parsePath("catalog://refused/**"))]) {
        const [operated] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] });
        const result: SchemeResult = Results.assert(operated);
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/catalog/resource-outside-root");
        assert.equal(result.problem.detail, "The source is outside its tree.");
    }
});

const setupRange = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `range-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Read the requested range and report it.");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, sessionId, loopId };
};

for (const channel of ["content", "reasoning"] as const) {
    for (const [scope, end] of [["<395,12>", 406], ["<395,+12>", 407]] as const) {
        test(`{§matcher-prefix-claims} ${channel} READ ${scope} returns the exact lines, preserves source and warns without a strike`, async (t) => {
            const { db, engine, ...context } = await setupRange();
            t.after(() => db.close());
            const lines = Array.from({ length: 410 }, (_, i) => `line ${i + 1}`);
            await seedEntryWithChannel(db, { workspaceId: context.workspaceId, pathname: "/range.txt", content: lines.join("\n") });
            const emission = PlurnkParser.frame(`READ (workspace:///range.txt) ${scope}`, null);
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: "", reasoning: null, [channel]: emission } },
                { assistant: { content: PlurnkParser.frame("SEND [200]", "done"), reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            const second = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102);
            assert.equal(second.status, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
            const read = logEntries(packet).find((row) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(row.logPath));
            assert.ok(read, "the explicit READ has its own receipt");
            if (channel === "content") assert.equal(packetSection(packet, "emission-history"), PlurnkParser.frame(`READ (workspace:///range.txt) <395,${end}>`, null));
            else assert.equal(read.path, "workspace:///range.txt", "an unpaired reasoning READ remains self-describing");
            const shown = String(read?.body).split("\n").filter(Boolean).map((line) => line.replace(/^\s*\d+<@[0-9A-Za-z]{5}>/u, ""));
            assert.deepEqual(shown, lines.slice(394, end));
            const notice = packetSection(packet, "notices");
            assert.ok(notice.includes(`Scope ${scope} was read as <395,${end}>.`), notice);
            assert.equal(notice.split("\n").filter((line) => line.includes("Scope ")).length, 1);
            assert.doesNotMatch(notice, /strike|no_operation|No valid Operation/u);
            const outcomes = await db.test_log_entries_by_turn.all<{ op: string; pathname: string; status_rx: number }>({ turn_id: first.turnId });
            assert.deepEqual(outcomes.filter(({ op, pathname }) => op === "READ" && pathname === "/range.txt").map(({ status_rx }) => status_rx), [200]);
            assert.ok(outcomes.every(({ status_rx }) => status_rx < 400), JSON.stringify(outcomes));
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: context.sessionId });
            assert.ok(sources.some(({ turn_id, kind, content }) => turn_id === first.turnId && kind === (channel === "content" ? "ops" : "reasoning") && content === emission),
                "normalization must not rewrite the forensic emission");
        });
    }
}

test("{§matcher-prefix-claims} FIND selects positions and anchor inversions remain real range errors", async (t) => {
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
        const found = await dispatch(`FIND (workspace:///range.txt) ${scope} /.+/`);
        assert.equal(found.status, 200, JSON.stringify(found));
        const matches = JSON.parse(String(found.content)) as { region: string }[];
        assert.deepEqual(matches.map(({ region }) => region), ["<3,1,3,6>", "<4,1,4,5>"], JSON.stringify(found));
    }
    const read = await dispatch("READ (workspace:///range.txt) <1,-1>");
    assert.equal(read.status, 200);
    const anchors = read.lineAnchors as string[];
    assert.equal(anchors.length, 5);
    for (const scope of [`<${anchors[3]},${anchors[1]}>`, "<4,1,2,1>", "<3.5,2>"]) {
        const refused = await dispatch(`READ (workspace:///range.txt) ${scope}`);
        assert.equal(refused.status, 416, JSON.stringify(refused));
        assert.match(String(refused.problem?.type), /\/range-not-satisfiable$/u);
    }
    const relative = await dispatch(`READ (workspace:///range.txt) <${anchors[2]},+1>`);
    assert.equal(relative.status, 200);
    assert.equal(relative.content, "three\nfour");
    const pastEnd = await dispatch("READ (workspace:///range.txt) <9,2>");
    assert.equal(pastEnd.status, 204);
    assert.equal(pastEnd.content, "", "a recovered range past EOF is the usual empty page");
    assert.deepEqual(pastEnd.range, { unit: "line", total: 5, requested: [9, 10] });
    assert.equal((await dispatch("READ (workspace:///range.txt) <4,3>")).content, "four\nfive", "recovered counts use ordinary end clamping");
    assert.equal((await dispatch("READ (workspace:///range.txt) <3,20>")).content, "three\nfour\nfive", "ordinary end clamping remains intact");
});

for (const scope of ["<3,2>", "<3,+1>"]) {
    test(`{§matcher-prefix-claims} EDIT, COPY, MOVE and KILL execute ${scope} through the same canonical range`, async (t) => {
        const { db, engine, ...context } = await setupRange();
        t.after(() => db.close());
        const seed = (name: string, content = "one\ntwo\nthree\nfour\nfive") => seedEntryWithChannel(db, { workspaceId: context.workspaceId, pathname: `/${name}`, content });
        for (const name of ["edited", "copied-from", "moved-from", "killed"]) await seed(name);
        for (const name of ["copied-to", "moved-to"]) await seed(name, "A\nB\nC\nD\nE");
        const program = [
            PlurnkParser.frame(`EDIT (workspace:///edited) ${scope}`, "replacement"),
            PlurnkParser.frame(`COPY (workspace:///copied-from) ${scope} (workspace:///copied-to) ${scope}`, null),
            PlurnkParser.frame(`MOVE (workspace:///moved-from) ${scope} (workspace:///moved-to) ${scope}`, null),
            PlurnkParser.frame(`KILL (workspace:///killed) ${scope}`, null),
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
