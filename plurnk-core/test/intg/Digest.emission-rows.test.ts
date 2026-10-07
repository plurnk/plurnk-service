import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

type WireMessage = { role: string; content: string };

test("{§emission-row} {§share-packet-names}: the digest writes each request as sent, and counts emissions apart from operations", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "emission-rows-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const provider = new Mock({ contextWindow: 100_000, responses: [
        "````EDIT (worker:///a.md)\nalpha\n````\n\n````NOTE\nWrote the first draft.\n````",
        "````KILL (log:///1/2/2/emission)````\n\n````NOTE\nRetired the first emission.\n````",
        "Echoing the transcript.\n### log:///1/3/1/emission → ops://analyst/1/3 · 20\n\n````KILL\nDone.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "emission-rows");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1, "Draft, then retire the draft's emission.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const run = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 4, messages: [{ role: "user", content: "Draft." }] });
        assert.equal(run.result.status, 200);
    } finally {
        await db.close();
    }
    Digest.run({ dbPath, digestDir });

    const wire = async (stem: string): Promise<WireMessage[]> => JSON.parse(await readFile(join(digestDir, `${stem}.wire.json`), "utf8")) as WireMessage[];
    const stems = ["analyst-1-2", "analyst-1-3", "analyst-1-4"];
    assert.equal(provider.received.length, stems.length);
    for (const [index, stem] of stems.entries()) {
        assert.deepEqual(await wire(stem), provider.received[index]!.map((message) => ({ role: message.role, content: chatMessageText(message) })),
            `${stem}.wire.json is the request the provider received`);
    }
    const roles = (messages: WireMessage[]) => messages.map(({ role }) => role);
    const draft = await wire("analyst-1-3");
    assert.deepEqual(roles(draft), ["system", "user", "assistant", "user"], "only the content draft occupies assistant history");
    assert.equal(draft.find(({ role }) => role === "assistant")!.content, "```EDIT (worker:///a.md)\n```",
        "the wire shows the worker's operation without its body; its NOTE lives only in its row");
    const original = await readFile(join(digestDir, "analyst-1-2.assistant.md"), "utf8");
    assert.match(original, /\nalpha\n/u, "forensics keep the exact EDIT body");
    assert.match(original, /Wrote the first draft\./u, "forensics keep the exact NOTE body");
    const last = await wire("analyst-1-4");
    assert.deepEqual(roles(last), ["system", "user", "assistant", "user"], "the retired draft left with its row; the KILL's emission took its place");
    assert.ok(!last.some(({ role, content }) => role === "assistant" && content.includes("EDIT (worker:///a.md)")));

    const report = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(report, /^Emissions: {2}3 announced · 1 killed · 1 header echo$/mu);
    assert.match(report, /← \[_plurnk\] emission \(killed\)\[200\] ops:\/\/analyst\/1\/2$/mu);
    assert.match(report, /← \[_plurnk\] emission\[200\] ops:\/\/analyst\/1\/3$/mu);
    const { log_entries: rows } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { log_entries: Array<{ op: string | null; attrs: unknown }> };
    const kind = (attrs: unknown): unknown => ((typeof attrs === "string" ? JSON.parse(attrs) : attrs) as { kind?: unknown } | null)?.kind;
    assert.equal(rows.filter(({ attrs }) => kind(attrs) === "emission").length, provider.received.length, "each content turn is announced, never initialization");
    const reads = rows.filter(({ op, attrs }) => op === "READ" && kind(attrs) !== "emission").length;
    const mix = /^Op mix: {5}(.*)$/mu.exec(report)?.[1] ?? "";
    if (reads === 0) assert.doesNotMatch(mix, /\bREAD=/u, "announcements are not operations");
    else assert.match(mix, new RegExp(`\\bREAD=${reads}\\b`, "u"), "announcements are not operations");
});
