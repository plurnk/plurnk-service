// Live exec — STRUCTURAL prompts allowed here. The model is explicitly
// told to use the EXEC op shape per plurnk.md; we're testing the
// machinery (parser → engine → exec scheme → spawn → channels → wake)
// against a real provider, not the model's tool-discovery ability.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveSession +
// liveLoop). The daemon wires the executors itself (Daemon.start), so this no
// longer hand-builds an ExecutorRegistry; the loop's completion implies the
// backgrounded spawn finished (the model SENT only after reading its result).

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop } from "../_live-harness.ts";

test("live exec: model emits <<EXEC[sh]:command:EXEC and the spawn captures stdout", async () => {
    const s = await liveSession({ name: `live-exec-${crypto.randomUUID()}` });
    try {
        const userPrompt = [
            "Two-turn probe.",
            "",
            "If you see an `exec:///...` log entry with stdout containing",
            "`plurnk-exec-live-ok`, emit:",
            "  <<SEND[200]:plurnk-exec-live-ok:SEND",
            "",
            "Otherwise, emit a single EXEC to run `echo plurnk-exec-live-ok` so that the next turn's",
            "log will have the exec entry. Emit ONLY the EXEC, no SEND yet:",
            "  <<EXEC[sh]:echo plurnk-exec-live-ok:EXEC",
            "",
            "Do not repeat the EXEC once you see the exec:///... entry in the log.",
        ].join("\n");

        const { finalStatus, hitMaxTurns, turnIds } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 8 }, { timeoutMs: 240_000 });

        const dumpTurns = async (): Promise<void> => {
            for (const turnId of turnIds) {
                const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
            }
        };
        if (finalStatus !== 200) await dumpTurns();
        assert.equal(finalStatus, 200);
        assert.equal(hitMaxTurns, false);

        // Verify a real exec entry was created and captured the probe string.
        const execEntryCount = (await (s.db.test_count_entries_by_session_scheme as PrepMethod).get<{ n: number }>({
            session_id: s.sessionId, scheme: "exec",
        }))?.n ?? 0;
        assert.ok(execEntryCount >= 1, "at least one exec:///r-<id> entry was created");

        // Find the exec entry and verify its stdout captured the probe. We don't
        // know the auto-generated id from outside; list session entries to find
        // any exec:///r-<id>.
        type EntryListRow = { scheme: string; pathname: string };
        const allEntries = await (s.db.test_list_entries_by_session_session_pathname as PrepMethod).all<EntryListRow>({ session_id: s.sessionId });
        const execEntries = allEntries.filter((e) => e.scheme === "exec");
        let foundProbe = false;
        for (const e of execEntries) {
            const entryRow = await (s.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
                scheme: "exec", pathname: e.pathname,
            });
            if (entryRow === undefined) continue;
            const stdout = await (s.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
                entry_id: entryRow.id, name: "stdout",
            });
            if ((stdout?.content ?? "").includes("plurnk-exec-live-ok")) {
                foundProbe = true;
                assert.equal(stdout?.state, "closed");
                break;
            }
        }
        if (!foundProbe) {
            await dumpTurns();
            for (const e of execEntries) {
                const entryRow = await (s.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({
                    scheme: "exec", pathname: e.pathname,
                });
                if (entryRow === undefined) continue;
                const stdout = await (s.db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({
                    entry_id: entryRow.id, name: "stdout",
                });
                console.error(`exec:///${e.pathname} stdout: state=${stdout?.state} content=${JSON.stringify(stdout?.content)}`);
            }
        }
        assert.ok(foundProbe, "an exec stdout channel captured the probe string");
    } finally { await s.cleanup(); }
});
