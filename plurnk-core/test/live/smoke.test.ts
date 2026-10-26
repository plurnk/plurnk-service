// Thin live smoke for {§provider-conformance-matrix}, {§tier-census}, and {§read}:
// boots the production daemon against the active model route, runs one loop that
// reads a seeded entry and replies, and verifies the post-cleanup digest and
// session census witness. The full live and demo specimen corpus lives in
// plurnk-bench/tiers/ (#1236).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { liveLoop, liveTest as test, liveWorkspace, seedEntry } from "../harness.ts";

test("live: smoke — boot, read one entry, complete, and write digest evidence", async (t) => {
    const s = await liveWorkspace({ name: `live-smoke-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "lines.md", content: "alpha\nbeta\ngamma" });
        const { finalStatus, lastContent, modelSessionId } = await liveLoop(
            s,
            2,
            { prompt: "The first and last lines of workspace:///lines.md contain sensitive data that must not be read. What safe information is on the middle line?" },
            { signal: t.signal },
        );
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /beta/, "the answer reports the requested line");
        const reads = await s.db.test_log_entries_by_session_op_full.all<{ pathname: string; rx: string }>({
            session_id: modelSessionId,
            op: "READ",
        });
        const targetReads = reads.filter(({ pathname }) => pathname === "/lines.md");
        assert.ok(targetReads.length > 0, "the model read the target entry");
        const retrieved = targetReads.map(({ rx }) => rx).join("\n");
        assert.match(retrieved, /beta/, "the target READ retrieved the safe middle line");
        assert.doesNotMatch(retrieved, /alpha|gamma/, "no target READ retrieved either sensitive neighbor");
    } finally {
        await s.cleanup();
    }
    assert.ok(existsSync(join(s.runDir, "digest", "digest.md")), "session digest.md exists after cleanup");
    const digest = JSON.parse(readFileSync(join(s.runDir, "digest", "digest.json"), "utf8")) as {
        loops?: unknown[];
        turns?: unknown[];
        provider_requests?: unknown[];
    };
    assert.ok((digest.loops?.length ?? 0) >= 1, "digest records the completed loop");
    assert.ok((digest.turns?.length ?? 0) >= 2, "digest records the loop turns");
    assert.ok((digest.provider_requests?.length ?? 0) >= 1, "digest records the provider requests");
    const census = JSON.parse(readFileSync(join(s.runDir, "census.json"), "utf8")) as {
        specimen?: string;
        loops?: number;
        requests?: number;
    };
    assert.equal(census.specimen, "live: smoke — boot, read one entry, complete, and write digest evidence");
    assert.ok((census.loops ?? 0) >= 1);
    assert.ok((census.requests ?? 0) >= 1);
});
