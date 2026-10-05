// {§packet-wire-envelope} {§emission-row} — the packet as a transcript: every admitted emission is the
// worker's own assistant message, in the chronological place of the log row that announces it.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText, type ChatMessage } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import EmissionHead from "../../src/core/EmissionHead.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { RequestPacket, StoredPacketSection } from "../../src/core/StoredPacket.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const say = (content: string, reasoning: string | null = null) => ({ assistant: { content, reasoning }, usage });
const surveyRead = PlurnkParser.frame("READ (reasoning://analyst/1/1)", null);
const roles = (request: readonly ChatMessage[]): string[] => request.map(({ role }) => role);
const assistants = (request: readonly ChatMessage[]): string[] => request.filter(({ role }) => role === "assistant").map(chatMessageText);
// {§packet-wire-envelope}: the user messages, joined by one blank line, are the user slot byte for byte.
const userText = (request: readonly ChatMessage[]): string => request.filter(({ role }) => role === "user").map(chatMessageText).join("\n\n");

const record = (coordinate: string, leaf: string, body = "x"): string => `### log:///${coordinate}/${leaf} · 12\n 1:${body}`;
const emissionRecord = (coordinate: string): string => `### log:///${coordinate}/emission → ops://w/${coordinate.split("/").slice(0, 2).join("/")} · 30`;
const packet = (records: readonly string[], closing = true): RequestPacket => {
    const sections: StoredPacketSection[] = [
        { name: "definition", slot: "system", header: null, content: "the card", weight: 4 },
        { name: "log", slot: "user", header: "Log", content: records.join("\n\n"), weight: 40 },
    ];
    if (closing) sections.push({ name: "worker", slot: "user", header: "Worker", content: JSON.stringify({ path: "worker://w", parent: null, loop: 1, turn: 3 }), weight: 8 });
    return { weight: 0, attributions: [], attachments: [], sections };
};

test("{§packet-wire-envelope}: each placed emission follows the user message its row ends; the clump closes the request", () => {
    const records = [emissionRecord("1/1/1"), record("1/1/2", "FIND"), record("1/2/1", "SEND"), emissionRecord("1/2/2"), record("1/2/3", "READ")];
    const emissions = new Map([["1/1/1", "```FIND (*)\n```"], ["1/2/2", "```READ (a.md)\n```"]]);
    const source = packet(records);
    const wire = PacketWire.packetToWireMessages(source, emissions) as ChatMessage[];
    assert.deepEqual(roles(wire), ["system", "user", "assistant", "user", "assistant", "user"]);
    assert.equal(wire[1]!.content, `## Log\n\n${records[0]}`, "the user stub: the log heading and the first emission's row");
    assert.equal(wire[2]!.content, emissions.get("1/1/1"));
    assert.equal(wire[3]!.content, `${records[1]}\n\n${records[2]}\n\n${records[3]}`, "the survey's result and the next turn's arrival, then the next emission's row");
    assert.equal(wire[4]!.content, emissions.get("1/2/2"));
    assert.equal(wire[5]!.content, `${records[4]}\n\n## Worker\n${source.sections[2]!.content}`, "the emission's result, then the clump");
    assert.equal(userText(wire), PacketWire.renderSlot(source.sections, "user"), "role boundaries only: the user slot's bytes are unchanged");
    assert.deepEqual(PacketWire.placedEmissions(source.sections, emissions), ["1/1/1", "1/2/2"]);
});

test("{§packet-wire-envelope}: a log without emission rows is one user message, and a request never ends on an emission", () => {
    const plain = packet([record("1/1/1", "READ"), record("1/1/2", "FIND")]);
    assert.deepEqual(roles(PacketWire.packetToWireMessages(plain, new Map()) as ChatMessage[]), ["system", "user"]);
    const ending = packet([emissionRecord("1/1/1")], false);
    assert.throws(() => PacketWire.packetToWireMessages(ending, new Map([["1/1/1", "```FIND (*)\n```"]])), /nothing follows the last one/u);
    const retired = packet([record("1/1/2", "FIND")]);
    assert.deepEqual(roles(PacketWire.packetToWireMessages(retired, new Map([["1/1/1", "```FIND (*)\n```"]])) as ChatMessage[]), ["system", "user"], "an emission whose row the log no longer carries is not placed");
});

test("{§emission-row} {§packet-wire-envelope}: an emission of only NOTE and WAIT is empty; its row stands and no assistant message follows it", () => {
    const records = [emissionRecord("1/1/1"), record("1/1/2", "FIND"), emissionRecord("1/2/2"), record("1/2/3", "NOTE")];
    const emissions = new Map([["1/1/1", "```FIND (*)\n```"], ["1/2/2", "```NOTE\nRemember.\n```"]]);
    const source = packet(records);
    const wire = PacketWire.packetToWireMessages(source, emissions) as ChatMessage[];
    assert.deepEqual(roles(wire), ["system", "user", "assistant", "user"]);
    assert.equal(wire[3]!.content, `${records[1]}\n\n${records[2]}\n\n${records[3]}\n\n## Worker\n${source.sections[2]!.content}`, "the empty emission's row stands in the merged user message");
    assert.deepEqual(PacketWire.placedEmissions(source.sections, emissions), ["1/1/1", "1/2/2"], "its row is still announced and placed");
});

test("{§emission-row}: an emission row the render pass did not announce, or announced twice, fails hard", () => {
    const orphan = packet([emissionRecord("1/2/2")]);
    assert.throws(() => PacketWire.placedEmissions(orphan.sections, new Map()), /reached the log section without its emission/u);
    const twice = packet([emissionRecord("1/2/2"), emissionRecord("1/2/2")]);
    assert.throws(() => PacketWire.placedEmissions(twice.sections, new Map([["1/2/2", "```READ (a.md)\n```"]])), /appears twice/u);
});

const run = async (name: string, prompt: string, responses: ReturnType<typeof say>[], maxTurns: number) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, name);
    const workerId = await insertWorker(db, workspaceId, null, "analyst");
    const loopId = await insertLoop(db, workerId, 1, prompt);
    const provider = new Mock({ contextWindow: 100000, responses });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, provider, messages: [], maxTurns });
    const rows = await db.test_emission_rows_by_worker.all<{
        coordinate: string; origin: string; op: string; scheme: string; hostname: string; pathname: string;
        attrs: string; rx: string; initial_folded: string; active: number; folded: string;
    }>({ worker_id: workerId });
    return { db, result, provider, rows, workerId };
};

test("{§emission-row} {§packet-token-accounting}: a long body keeps its head behind the aside, NOTE text lives only in its row, and source READ restores exact bodies", async (t) => {
    const body = Array.from({ length: 120 }, (_line, index) => `PREVIEWED-BODY line ${index + 1}`).join("\n");
    const edit = PlurnkParser.frame("EDIT (worker:///memory.md) <!-- remember -->", body);
    const first = `${edit}\n\n${PlurnkParser.frame("NOTE", "CURATABLE-MEMORY: retain the actual observation.")}`;
    const reasoning = PlurnkParser.frame("NOTE", "REASONING-MEMORY: independent reasoning note.");
    const head = `${EmissionHead.cut(body).head.replace(/\r?\n$/u, "")}…`;
    assert.ok(head.split("\n").length < 20, "the head is a flat ~100-token cut, far short of the 120-line body ({§emission-row})");
    const header = `${PlurnkParser.frame("EDIT (worker:///memory.md) <!-- remember -->", head)} <!-- display cut; the statement arrived whole: READ (ops://analyst/1/2) for the full body -->`;
    const { db, result, provider, rows, workerId } = await run("envelope-header-history", "Work, curate, then inspect your original program.", [
        say(first, reasoning),
        say(PlurnkParser.frame("KILL (log:///1/2/*/NOTE)", null)),
        say(PlurnkParser.frame("READ (ops://analyst/1/2) <1,-1>", null)),
        say(PlurnkParser.frame("KILL", "Complete.")),
    ], 5);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 4);
    const second = provider.received[1]!;
    assert.equal(assistants(second).at(-1), header, "the long body keeps its head, its closer names the source, and the NOTE is not announced");
    assert.match(userText(second), /CURATABLE-MEMORY/u, "the content NOTE remains ordinary working memory");
    assert.match(userText(second), /REASONING-MEMORY/u, "reasoning NOTE memory remains independent of assistant history");
    const third = provider.received[2]!;
    assert.doesNotMatch(assistants(third).join("\n"), /CURATABLE-MEMORY|REASONING-MEMORY/u, "curating notes leaves no automatic assistant duplicate");
    assert.doesNotMatch(userText(third), /CURATABLE-MEMORY/u, "the curated NOTE row is gone from the log");
    assert.equal(assistants(third)[0], header, "a later request does not change the retained header");
    assert.equal(assistants(third).at(-1), "```KILL (log:///1/2/*/NOTE)\n```", "a bodyless operation renders bare");
    const last = provider.received[3]!;
    assert.match(userText(last), /CURATABLE-MEMORY/u, "an explicit READ retrieves the complete source program");
    assert.match(userText(last), /PREVIEWED-BODY line 120/u, "including the cut remainder");
    assert.doesNotMatch(assistants(last).join("\n"), /CURATABLE-MEMORY|REASONING-MEMORY|PREVIEWED-BODY line 101/u);
    const reads = await db.test_log_entries_by_worker_op_full.all<{ pathname: string; rx: string }>({ worker_id: workerId, op: "READ" });
    assert.ok(reads.some(({ pathname, rx }) => pathname === "/1/2" && (JSON.parse(rx) as { content?: string }).content === first), "the source READ returns the complete original program, not the header projection");
    const emitted = rows.find(({ coordinate }) => coordinate.startsWith("1/2/"))!;
    assert.equal((JSON.parse(emitted.rx) as { content: string }).content,
        `${header}\n\n${PlurnkParser.frame("NOTE", "CURATABLE-MEMORY: retain the actual observation.")}`,
        "the frozen projection keeps every statement; only the wire omits the NOTE");
    const record = userText(second).split("\n\n").find((text) => /^### log:\/\/\/1\/2\/\d+\/emission/u.test(text))!;
    const charged = Number(/ · (\d+)/u.exec(record)![1]);
    assert.equal(charged, contentWeight(record) + contentWeight(header), "the row charges its record and precisely the assistant bytes it delivers");
    assert.ok(charged < contentWeight(first), "the cut remainder is not charged as assistant history");
});

test("{§emission-row} {§packet-wire-envelope}: initialization remains in the log; each content emission rides behind its own row", async (t) => {
    const first = `Let me look around first.\n\n${surveyRead}\n\n${PlurnkParser.frame("NOTE", "Bearings: nothing read yet.")}\n\nDone for now.`;
    const { db, result, provider, rows } = await run("envelope-transcript", "Answer.", [say(first), say(PlurnkParser.frame("KILL", "Answer."))], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);

    assert.deepEqual(rows.map(({ coordinate }) => coordinate), ["1/2/2", "1/3/1"], "only model content turns announce emissions, after their inputs");
    for (const row of rows) {
        assert.equal(row.origin, "_plurnk");
        assert.equal(row.op, "READ");
        assert.equal(row.scheme, "ops");
        assert.equal(row.pathname, `/${row.coordinate.split("/").slice(0, 2).join("/")}`);
        assert.deepEqual(JSON.parse(row.initial_folded), [[1, -1]], "born folded: the log shows only the row; the emission is the assistant message");
        assert.equal(row.active, 1);
    }
    const texts = rows.map(({ rx }) => (JSON.parse(rx) as { content: string }).content);
    assert.equal(texts[0], `${surveyRead}\n\n${PlurnkParser.frame("NOTE", "Bearings: nothing read yet.")}`, "frozen with every admitted content statement");
    const delivered = texts.map((text) => PacketWire.deliveredEmission(text));
    assert.equal(delivered[0], surveyRead, "the wire delivers it without the NOTE, whose row shows it whole");
    assert.doesNotMatch(texts[0]!, /Let me look around|Done for now/u, "free text never reaches the emission");

    const opening = provider.received[0]!;
    assert.deepEqual(roles(opening), ["system", "user"]);
    assert.doesNotMatch(chatMessageText(opening[1]!), /\/emission →/u, "initialization creates no content announcement");

    const second = provider.received[1]!;
    assert.deepEqual(roles(second), ["system", "user", "assistant", "user"]);
    assert.deepEqual(assistants(second), [delivered[0]], "only the admitted content emission appears");
    assert.match(chatMessageText(second[1]!), /### log:\/\/\/1\/2\/1\/SEND[\s\S]*\n\n### log:\/\/\/1\/2\/2\/emission → ops:\/\/[^/\s]+\/1\/2 · \d+$/u, "the arrival turn 2 answered, then its emission's row, a bare heading because the model wrote it");
    assert.match(chatMessageText(second[3]!), /^### log:\/\/\/1\/2\/3\/READ\b/u, "the emission's result follows it");
    assert.match(chatMessageText(second[3]!), /## Worker\n\{"path":"worker:\/\/[^"]+","parent":null,"loop":1,"turn":3\}/u, "the Worker block names the actor and the turn, nothing else");
});

test("{§emission-row}: a whole KILL of an emission row takes its emission off the wire, and the user messages around it merge", async (t) => {
    const { db, result, provider, rows } = await run("envelope-kill", "Answer.", [
        say(surveyRead),
        say(PlurnkParser.frame("KILL (log:///1/2/2/emission)", null)),
        say(PlurnkParser.frame("KILL", "Answer.")),
    ], 4);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(rows.find(({ coordinate }) => coordinate === "1/2/2")!.active, 0, "the row is retired");
    assert.ok(assistants(provider.received[1]!).includes(surveyRead), "the emission was present before its KILL");
    const last = provider.received.at(-1)!;
    assert.ok(!assistants(last).includes(surveyRead), "its emission left the wire");
    assert.deepEqual(assistants(last), [PlurnkParser.frame("KILL (log:///1/2/2/emission)", null)], "only the KILL's own emission remains");
    assert.doesNotMatch(userText(last), /log:\/\/\/1\/2\/2\/emission/u, "its row left the log");
});

test("{§emission-row}: a <1,-1> scope retires an emission; a partial scope aimed at one is refused; a partial sweep leaves it intact", async (t) => {
    const noted = PlurnkParser.frame("EDIT (worker:///scope.md)", "line one\nline two\nline three");
    const { db, result, provider, rows } = await run("envelope-scope", "Answer.\nSecond line.\nThird line.", [
        say(noted),
        say(PlurnkParser.frame("KILL (log:///1/2/2/emission) <2,3>", null)),
        say(PlurnkParser.frame("KILL (log:///1/2/*) <2,3>", null)),
        say(PlurnkParser.frame("KILL (log:///1/2/2/emission) <1,-1>", null)),
        say(PlurnkParser.frame("KILL", "Answer.")),
    ], 6);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    const refused = provider.received[2]!;
    assert.match(userText(refused), /### log:\/\/\/1\/3\/\d+\/KILL → log:\/\/\/1\/2\/2\/emission[^\n]*\n\{[^\n]*"status":422/u, "the exact partial scope is refused");
    assert.match(userText(refused), /curated whole/u, "and the refusal says why");
    assert.ok(assistants(refused).includes(noted), "the emission is untouched by the refusal");
    assert.ok(assistants(provider.received[3]!).includes(noted), "a partial sweep leaves the emission intact");
    assert.ok(!assistants(provider.received[4]!).includes(noted), "<1,-1> retires it");
    const retired = rows.find(({ coordinate }) => coordinate === "1/2/2")!;
    assert.equal(retired.active, 0);
    assert.deepEqual(JSON.parse(retired.folded), [], "never trimmed, only retired");
});

test("{§emission-row} {§fabricated-log-entry}: an echoed emission heading is tolerated outside text and never reaches the emission", async (t) => {
    const echoed = `### log:///1/2/2/emission → ops://exampleWorkerName/1/2 · 30\n\n${surveyRead}`;
    const { db, result, provider, rows } = await run("envelope-echo", "Answer.", [say(echoed), say(PlurnkParser.frame("KILL", "Answer."))], 3);
    t.after(() => db.close());
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2, "admitted on the first attempt, not rejected");
    assert.equal((JSON.parse(rows.find(({ coordinate }) => coordinate === "1/2/2")!.rx) as { content: string }).content, surveyRead, "the emission contains only the announced statement");
});
