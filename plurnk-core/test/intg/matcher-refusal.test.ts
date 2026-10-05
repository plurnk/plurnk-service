import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";

const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Inspect the notes." }];
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });

test("{§matcher-refusal}: a fumbled pattern is the operation's own 400 with the parser's working form, never an error row and never a strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `matcher-refusal-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Inspect the notes.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Enum one\nEnum two\n" });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response("````FIND (worker:///notes.md) /Enum/{5,40} <!-- enum regions -->````"),
            response("````FIND (worker:///notes.md) /Enum/{5,40}````"),
            response("````NOTE\nstill looking\n````"),
        ] });
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider });
        assert.equal(first.status, 102, "the turn stands");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number; rx: string }>({ turn_id: first.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["FIND", 400]], "one row: the FIND's own refusal");
        assert.ok(rows.every(({ op }) => op !== "error"), "no grammar error row is minted");
        const problem = (JSON.parse(rows.find(({ op }) => op === "FIND")!.rx) as { problem: { type: string; detail: string; recovery: string; stage: string } }).problem;
        assert.equal(problem.type, "https://problems.plurnk.xyz/grammar/matcher/unreadable-pattern");
        assert.match(problem.detail, /not a valid `\/pattern\/flags` regex/u);
        assert.match(problem.recovery, /^A pattern is a regex written/u, "{§parse-recovery}: the working form rides the Problem");
        assert.equal(problem.stage, "matcher");
        assert.equal(await new StrikeRail(db).streak(loopId), 0, "a turn of nothing but a fumbled pattern earns no strike");
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider });
        assert.equal(await new StrikeRail(db).streak(loopId), 0, "nor does repeating it");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
        assert.match(packetSection(packet, "errors"), /"status":400,"path":"log:\/\/\/[^"]*\/FIND"/u, "the refusal is the FIND row in the Errors index");
        const row = logEntries(packet).find((entry) => entry.status === 400 && String(entry.logPath).endsWith("/FIND"))!;
        assert.match(String((row.problem as { detail?: string }).detail), /not a valid/u, "the next packet carries the diagnostic on the row");
        assert.match(String((row.problem as { recovery?: string }).recovery), /A pattern is a regex/u);
    } finally { await db.close(); }
});
