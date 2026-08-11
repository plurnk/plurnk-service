// Live coverage of model-to-operation mapping for {§read}, {§edit}, {§find},
// {§copy}, and entry KILL, including text-region and matcher forms.
//
// Each test is ONE natural sentence that can only mean ONE op — the op is NEVER
// spelled out. Showing the literal op triggers model meta-awareness about the
// "mission" (it loops on that meta-confusion instead of acting) and tests the
// parser rather than the intent→op mapping that is the real surface. Verify
// FORENSICALLY against the db: state-changing ops by entry/channel content,
// read-only ops by the op's logged rx. Never assert on the model's narration.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveWorkspace +
// liveLoop). Seeding is a precondition (the state the prompt references); the
// loop is 100% prod, the same path production runs.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, seedEntry, readBody, lastRx } from "../_live-harness.ts";

const TIMEOUT = Number(process.env.PLURNK_LIVE_TIMEOUT ?? 240_000); // raise for slow/remote endpoints

test("live: READ <L> — slice the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-read-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "lines.md", content: "alpha\nbeta\ngamma" });
        const { modelWorkerId } = await liveLoop(s, 2, { prompt: "What is on the second line of worker:///lines.md?" }, { timeoutMs: TIMEOUT });
        const rx = await lastRx(s.db, modelWorkerId, "READ");
        assert.match(rx, /beta/);
        assert.doesNotMatch(rx, /alpha|gamma/); // a <2> slice, not a whole-file read
    } finally { await s.cleanup(); }
});

test("live: FIND regex — locate a pattern in an entry's content", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-find-regex-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "doc.md", content: "hello world hello again" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "Find every occurrence of the word `hello` in worker:///doc.md." }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /hello/i, "the answer reports the occurrences");
    } finally { await s.cleanup(); }
});

test("live: EDIT <L> — replace the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-edit-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "poem.md", content: "roses are red\nviolets are blue" });
        // The prompt IS the test: one sentence that can only mean EDIT<2>.
        await liveLoop(s, 2, { prompt: "Replace the second line of worker:///poem.md with `violets are bright`." }, { timeoutMs: TIMEOUT });
        assert.equal(await readBody(s.db, "poem.md"), "roses are red\nviolets are bright");
    } finally { await s.cleanup(); }
});

test("live: content-match selection — the model culls entries by CONTENT (fruit), verified forensically", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-content-select-${crypto.randomUUID()}` });
    try {
        // Content-based SELECTION: the model must decide which entries qualify by reading their
        // CONTENT, not their path. Two guards make this a real test of that:
        //   1. De-leaked — the fruit lives ONLY in content. The paths are neutral stems
        //      (alpha/bravo/charlie) and the prompt says "a fruit", never "apple/lemon". The old
        //      fixture leaked the answer in BOTH the prompt ("apple or lemon") and the paths
        //      (fruits/apple.md), so a model that read nothing still passed — a near-tautology.
        //   2. Forensic outcome, no narration, no dictated op (harness doctrine, top of file): we
        //      assert what SURVIVES in the db. A content-matcher FIND or a body-less list + READs —
        //      either path to the right cull passes; the model chooses how.
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/alpha.md", content: "a crisp autumn apple, freshly picked" });
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/bravo.md", content: "a sour yellow lemon" });
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/charlie.md", content: "buy milk and bread" });
        await liveLoop(s, 3, { prompt: "Tidy the pantry: delete every entry in worker:///pantry/ whose content does not name a fruit." }, { timeoutMs: TIMEOUT });
        assert.equal(await readBody(s.db, "pantry/charlie.md"), undefined, "milk & bread is no fruit — read, classified, deleted");
        assert.match(await readBody(s.db, "pantry/alpha.md") ?? "", /apple/, "the apple entry is a fruit — kept");
        assert.match(await readBody(s.db, "pantry/bravo.md") ?? "", /lemon/, "the lemon entry is a fruit — kept");
    } finally { await s.cleanup(); }
});

test("live: copy a line range into a new entry", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-copy-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "src.md", content: "one\ntwo\nthree\nfour" });
        await liveLoop(s, 2, { prompt: "Copy the second and third lines of worker:///src.md into a new entry worker:///slice.md." }, { timeoutMs: TIMEOUT });
        assert.match(await readBody(s.db, "slice.md") ?? "", /^two\nthree\n?$/, "the result contains only source lines 2-3");
    } finally { await s.cleanup(); }
});

test("live: KILL — delete an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveWorkspace({ name: `live-contract-delete-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "obsolete.md", content: "no longer needed" });
        // KILL is the canonical delete (MOVE→/dev/null retired); the model earns
        // the op from a plain delete request — we verify the entry is gone.
        await liveLoop(s, 2, { prompt: "Delete the entry worker:///obsolete.md." }, { timeoutMs: TIMEOUT });
        assert.equal(await readBody(s.db, "obsolete.md"), undefined);
    } finally { await s.cleanup(); }
});
