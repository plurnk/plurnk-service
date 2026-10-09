// {§emission-row} {§previous-emission}: durable programs, curatable records, one complete replay.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { killStmt, urlPath } from "./_dsl.ts";

const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning } });
const frame = PlurnkParser.frame;
const surveyRead = frame("READ (reasoning://analyst/1/1)", null);
const userText = (request: readonly ChatMessage[]): string => request.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");
const previous = (request: readonly ChatMessage[]): string => request.filter(({ role }) => role === "assistant").map(chatMessageText).join("\n\n");

const run = async (name: string, prompt: string, responses: ReturnType<typeof say>[], maxTurns: number) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, name);
    const workerId = await insertWorker(db, workspaceId, null, "analyst");
    const loopId = await insertLoop(db, workerId, 1, prompt);
    const provider = new Mock({ contextWindow: 100000, responses });
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    const result = await engine.runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns });
    const rows = await db.test_emission_rows_by_worker.all<{
        coordinate: string; origin: string; op: string; scheme: string; hostname: string; pathname: string;
        attrs: string; rx: string; initial_folded: string; active: number; folded: string;
    }>({ worker_id: workerId });
    return { db, result, provider, rows, workspaceId, workerId, loopId, engine, schemes };
};

test("{§previous-emission}: curation removes memory receipts; source READ still restores exact bodies", async (t) => {
    const body = Array.from({ length: 120 }, (_, index) => `FULL-BODY line ${index + 1}`).join("\n");
    const first = `${frame("EDIT (worker:///memory.md) <!-- remember -->", body)}\n\n${frame("NOTE", "CURATABLE-MEMORY: retain the actual observation.")}`;
    const curate = frame("KILL (log:///1/2/*/NOTE)", null);
    const read = frame("READ (ops://analyst/1/2) <1,-1>", null);
    const { db, result, provider, rows, workerId } = await run("envelope-source", "Work, curate, then inspect your original program.", [
        say(first, frame("NOTE", "REASONING-MEMORY: independent reasoning note.")),
        say(curate), say(read), say(frame("SEND [200]", "Complete.")),
    ], 5);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 4);
    assert.equal(previous(provider.received[1]!), first);
    assert.match(userText(provider.received[1]!), /REASONING-MEMORY/u);
    assert.equal(previous(provider.received[2]!), curate);
    assert.doesNotMatch(userText(provider.received[2]!), /CURATABLE-MEMORY/u, "the curated NOTE has no historical replay duplicate");
    assert.equal(previous(provider.received[3]!), read);
    assert.match(userText(provider.received[3]!), /CURATABLE-MEMORY/u, "an explicit READ retrieves the complete program");
    assert.match(userText(provider.received[3]!), /FULL-BODY line 120/u);
    const reads = await db.test_log_entries_by_worker_op_full.all<{ pathname: string; rx: string }>({ worker_id: workerId, op: "READ" });
    assert.ok(reads.some(({ pathname, rx }) => pathname === "/1/2" && (JSON.parse(rx) as { content?: string }).content === first));
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate.startsWith("1/2/"))!.rx) as { content: string }).content, first);
});

test("{§emission-row}: initialization has no replay; canonical content excludes interstitial text and preserves row chronology", async (t) => {
    const canonical = `${surveyRead}\n\n${frame("NOTE", "Bearings: nothing read yet.")}`;
    const { db, result, provider, rows } = await run("envelope-chronology", "Answer.", [
        say(`Let me look around first.\n\n${canonical}\n\nDone for now.`), say(frame("SEND [200]", "Answer.")),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.deepEqual(rows.map(({ coordinate }) => coordinate), ["1/2/2", "1/3/1"]);
    for (const row of rows) {
        assert.equal(row.origin, "_plurnk");
        assert.equal(row.op, "READ");
        assert.equal(row.scheme, "ops");
        assert.equal(row.pathname, `/${row.coordinate.split("/").slice(0, 2).join("/")}`);
        assert.deepEqual(JSON.parse(row.initial_folded), [[1, -1]]);
        assert.equal(row.active, 1);
    }
    assert.equal(previous(provider.received[0]!), "");
    assert.equal(previous(provider.received[1]!), canonical);
    assert.match(userText(provider.received[1]!), /### log:\/\/\/1\/2\/1\/SEND[\s\S]*### log:\/\/\/1\/2\/2\/emission[\s\S]*### log:\/\/\/1\/2\/3\/READ/u);
    assert.doesNotMatch(previous(provider.received[1]!), /Let me look around|Done for now/u);
});

test("{§emission-row}: curation retires the immediately preceding emission without reviving an older one", async (t) => {
    const f = await run("envelope-retire", "Work.", [say(surveyRead), say(frame("NOTE", "Newest program."))], 2);
    t.after(() => f.db.close());
    const builder = new PacketBuilder({ db: f.db, schemes: f.schemes, executors: () => undefined });
    const build = () => builder.buildRequestPacket({ ...f, initialMessages: [], currentTurnSeq: 5, gitStatus: null });
    assert.equal(PacketWire.sectionContent(await build(), "previous-emission"), frame("NOTE", "Newest program."));
    const last = f.rows.at(-1)!;
    const turnId = await insertTurn(f.db, f.loopId, 4);
    const result = await f.engine.dispatch({ ...f, turnId, sequence: 1, origin: "model", statement: killStmt(urlPath("log", `/${last.coordinate}/emission`)) });
    assert.equal(result.status, 200);
    assert.equal(PacketWire.sectionContent(await build(), "previous-emission"), "");
    assert.ok(PacketWire.sectionContent(await build(), "log").includes("log:///1/2/2/emission"), "an older live emission is not replayed");
});

test("{§emission-row}: a whole scope retires an emission; a partial scope refuses and a partial sweep preserves it", async (t) => {
    const { db, result, provider, rows } = await run("envelope-scope", "Answer.\nSecond line.\nThird line.", [
        say(frame("EDIT (worker:///scope.md)", "line one\nline two\nline three")),
        say(frame("KILL (log:///1/2/2/emission) <2,3>", null)),
        say(frame("KILL (log:///1/2/*) <2,3>", null)),
        say(frame("KILL (log:///1/2/2/emission) <1,-1>", null)), say(frame("SEND [200]", "Answer.")),
    ], 6);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.match(userText(provider.received[2]!), /### log:\/\/\/1\/3\/\d+\/KILL → log:\/\/\/1\/2\/2\/emission[^\n]*\n\{[^\n]*"status":422/u);
    assert.match(userText(provider.received[2]!), /curated whole/u);
    assert.match(userText(provider.received[2]!), /### log:\/\/\/1\/2\/2\/emission/u);
    assert.match(userText(provider.received[3]!), /### log:\/\/\/1\/2\/2\/emission/u);
    assert.doesNotMatch(userText(provider.received[4]!), /### log:\/\/\/1\/2\/2\/emission/u);
    const retired = rows.find(({ coordinate }) => coordinate === "1/2/2")!;
    assert.equal(retired.active, 0);
    assert.deepEqual(JSON.parse(retired.folded), []);
});

test("{§emission-row} {§fabricated-log-entry}: an echoed emission heading is tolerated outside text, never replayed", async (t) => {
    const { db, result, provider, rows } = await run("envelope-echo", "Answer.", [
        say(`### log:///1/2/2/emission → ops://exampleWorkerName/1/2 · 30\n\n${surveyRead}`), say(frame("SEND [200]", "Answer.")),
    ], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate === "1/2/2")!.rx) as { content: string }).content, surveyRead);
    assert.equal(previous(provider.received[1]!), surveyRead);
});
