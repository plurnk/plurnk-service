// {§client-entry-address} A client read acquires each kind of address as exact READ does, from the session's perspective:
// a representation core computes, a core scheme's prepared entry, a message core retains whichever module minted its
// address, and any other scheme's entry as stored, its acquisition never run.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { MessageScheme, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import { Validator, type EntryReadResult, type ParsedPath } from "@plurnk/plurnk-contracts";
import { parsePath } from "@plurnk/plurnk-parser";
import { contentWeight } from "../../src/core/content-weight.ts";
import { makeMockResponse } from "./_mock.ts";
import { killStmt } from "./_dsl.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";

const reasoned = (dsl: string, reasoning: string) => {
    const response = makeMockResponse(dsl);
    return { ...response, assistant: { ...response.assistant, reasoning } };
};

// An extension's data scheme whose acquisition would reach outside the daemon: it counts every preparation.
class Remote implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "remote", authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model"], volatile: true, modelVisible: true,
    };
    prepared = 0;

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string } | null> {
        return target.kind === "url" ? { authority: target.hostname ?? "", pathname: target.pathname } : null;
    }

    async prepareRepresentation(): Promise<{ status: 200 }> {
        this.prepared += 1;
        return { status: 200 };
    }
}

const typeOf = (result: EntryReadResult): string | null => result.entry === null ? result.problem.type.replace(/^.*\//u, "") : null;

// Under the shipped database posture, and with a reader Session beside the writer, the other posture an operator may choose
// (`PLURNK_SERVICE_SQLITE_READERS`): every read here follows a write it must see.
for (const readers of [undefined, 1]) test(`{§client-entry-address} a client read acquires every kind of address as exact READ does, and runs only core's acquisition (${readers === undefined ? "shipped readers" : `${readers} reader`})`, async () => {
    const thought = "Weighing the note.";
    const minted = "proto://anonymous/threads/t/messages/m1";
    const provider = new Mock({ contextWindow: 32768, responses: [
        reasoned("````NOTE\nOne.\nTwo.\nThree.\n````", thought),
        makeMockResponse("````SEND [200]\nThe answer.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "entry-acquisition" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const remote = new Remote();
        await daemon.registerScheme("proto", new MessageScheme("proto"));
        await daemon.registerScheme("remote", remote);
        const terminated = new Set<number>();
        const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
            if (method === "loop/terminated") terminated.add((params as { loopId: number }).loopId);
        });
        try {
            const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Think, then answer.", source: minted, messageAddress: minted });
            await waitForDb(async () => terminated.has(loopId), (done) => done);
        } finally {
            off();
        }
        const rows = await daemon.readLog({ workspaceId, sessionId });
        const note = rows.find(({ op }) => op === "NOTE");
        // {§message-short-identity} The arrival's receipt names the message by its short address.
        const short = rows.flatMap(({ origin, rx }) => origin === "_plurnk" && typeof (rx as { resource?: unknown } | null)?.resource === "string"
            ? [(rx as { resource: string }).resource] : []).find((resource) => resource.startsWith("message://"));
        assert.ok(note !== undefined && short !== undefined, "the turn noted, and its arrival names its message");
        const coordinate = `${note.loop_seq}/${note.turn_seq}/${note.sequence}`;
        // {§log-readable-projection} A deliberate scoped KILL trims the row's second line from every later reader.
        const trimmed = await modelOperation(daemon, db, { workspaceId, sessionId, statement: killStmt(parsePath(`log:///${coordinate}/NOTE`), { marks: [2] }) });
        assert.equal(trimmed.status, 200);
        const read = async (target: string, slice: { channel?: string; offset?: number } = {}): Promise<EntryReadResult> =>
            Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId, target, ...slice }));

        // A log row is computed: no stored entry, the canonical coordinate, its unnamed default channel, trimmed.
        const kept = "One.\nThree.";
        assert.deepEqual(await read(`log:///${coordinate}/NOTE`), { status: 200, entry: {
            entryId: null, target: `log:///${coordinate}/NOTE`,
            channels: { "": { content: kept, contentOffset: 0, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" } },
        } });
        assert.deepEqual((await read(`log:///${coordinate}/NOTE`, { channel: "", offset: 5 })).entry?.channels[""],
            { content: "Three.", contentOffset: 5, contentLength: kept.length, mimetype: "text/plain", weight: contentWeight(kept), state: "static" },
            "a computed channel slices by code points, as a stored one does");
        const unknownChannel = await read(`log:///${coordinate}/NOTE`, { channel: "patch" });
        assert.deepEqual([unknownChannel.status, typeOf(unknownChannel)], [404, "channel-not-found"]);

        // A turn's sources are computed by the session they name; its reasoning is the text its first operation row projects.
        assert.equal(note.reasoning, thought);
        const reasoning = await read(`reasoning://main/${note.loop_seq}/${note.turn_seq}`);
        assert.equal(reasoning.entry?.entryId, null);
        assert.deepEqual(reasoning.entry?.channels.body && [reasoning.entry.channels.body.content, reasoning.entry.channels.body.mimetype], [thought, "text/plain"]);
        const answer = rows.find(({ origin, turn_seq }) => origin === "model" && turn_seq !== note.turn_seq);
        assert.equal((await read(`reasoning://main/${note.loop_seq}/${answer?.turn_seq}`)).entry?.channels.body?.content, "", "a turn that reasoned none reads empty");
        const program = await read(`ops://main/${note.loop_seq}/${note.turn_seq}`);
        assert.deepEqual([program.entry?.entryId, program.entry?.channels.body?.mimetype], [null, "text/vnd.plurnk"], "the turn's program");

        // The core message scheme prepares its entry; a message an extension minted is materialized by core.
        for (const [target, label] of [[short, "the short address"], [minted, "the minted address"]] as const) {
            const message = await read(target);
            assert.ok((message.entry?.entryId ?? 0) > 0, `${label} reads a stored entry`);
            assert.equal(message.entry?.channels.body?.content, "Think, then answer.", `${label} holds the words`);
        }

        // An extension's acquisition never runs for a client: what it never stored is not there.
        const unfetched = await read("remote://example.test/page");
        assert.deepEqual([unfetched.status, typeOf(unfetched), remote.prepared], [404, "entry-not-found", 0]);

        // {§methods-entry-channel-read} The channel an address selects, complete: its fragment's, else its scheme's default.
        const selected = async (target: string): Promise<EntryReadResult> =>
            Validator.assertEntryReadResult(await daemon.readEntryChannel({ workspaceId, sessionId, target }));
        for (const [target, channel, content] of [
            [`log:///${coordinate}/NOTE`, "", kept],
            [`reasoning://main/${note.loop_seq}/${note.turn_seq}`, "body", thought],
            [`${minted}#body`, "body", "Think, then answer."],
        ] as const) {
            const one = await selected(target);
            assert.deepEqual([Object.keys(one.entry?.channels ?? {}), one.entry?.channels[channel]?.content], [[channel], content], target);
        }
        const absent = await selected(`log:///${coordinate}/NOTE#patch`);
        assert.deepEqual([absent.status, typeOf(absent)], [404, "channel-not-found"]);

        // Another workspace reads none of this session's addresses.
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "entry-acquisition-elsewhere" });
        await assert.rejects(daemon.readEntry({ workspaceId: elsewhere, sessionId, target: `reasoning://main/${note.loop_seq}/${note.turn_seq}` }),
            (error: unknown) => (error as { result?: { status?: number } }).result?.status === 409);

        // The scheme's own refusals stand.
        for (const [target, status, code] of [
            ["log:///x", 400, "coordinate-malformed"],
            [`log:///9/9/9/NOTE`, 404, "entry-not-found"],
            [`reasoning://main/${note.loop_seq}/99`, 404, "entry-not-found"],
        ] as const) {
            const refused = await read(target);
            assert.deepEqual([refused.status, typeOf(refused), refused.entry], [status, code, null], target);
        }
    }, readers === undefined ? {} : { readers });
});
