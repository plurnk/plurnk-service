// Live coverage of contract surfaces (landed under #171): READ <L>, READ regex
// matcher, EDIT <L>, FIND regex, COPY <L> source range, KILL entry delete.
//
// Each test is ONE natural sentence that can only mean ONE op — the op is NEVER
// spelled out. Showing the literal op triggers model meta-awareness about the
// "mission" (it loops on that meta-confusion instead of acting) and tests the
// parser rather than the intent→op mapping that is the real surface. Verify
// FORENSICALLY against the db: state-changing ops by entry/channel content,
// read-only ops by the op's logged rx. Never assert on the model's narration.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveSession +
// liveLoop). Seeding is a precondition (the state the prompt references); the
// loop is 100% prod, the same path production runs.

import test from "node:test";
import assert from "node:assert/strict";
import { liveSession, liveLoop, seedEntry, readBody, lastRx } from "../_live-harness.ts";

const TIMEOUT = 240_000;

test("live: READ <L> — slice the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-read-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "lines.md", content: "alpha\nbeta\ngamma" });
        const { modelRunId } = await liveLoop(s, 2, { prompt: "What is on the second line of known:///lines.md?" }, { timeoutMs: TIMEOUT });
        const rx = await lastRx(s.db, modelRunId, "READ");
        assert.match(rx, /beta/);
        assert.doesNotMatch(rx, /alpha|gamma/); // a <2> slice, not a whole-file read
    } finally { await s.cleanup(); }
});

test("live: READ regex — extract a pattern from an entry's content", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-read-regex-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "doc.md", content: "hello world hello again" });
        const { modelRunId } = await liveLoop(s, 2, { prompt: "Find every occurrence of the word `hello` in known:///doc.md." }, { timeoutMs: TIMEOUT });
        assert.match(await lastRx(s.db, modelRunId, "READ"), /hello/);
    } finally { await s.cleanup(); }
});

test("live: EDIT <L> — replace the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-edit-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "poem.md", content: "roses are red\nviolets are blue" });
        // The prompt IS the test: one sentence that can only mean EDIT<2>.
        await liveLoop(s, 2, { prompt: "Replace the second line of known:///poem.md with `violets are bright`." }, { timeoutMs: TIMEOUT });
        assert.equal(await readBody(s.db, "poem.md"), "roses are red\nviolets are bright");
    } finally { await s.cleanup(); }
});

test("live: FIND — select entries by a content match", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-find-content-${crypto.randomUUID()}` });
    try {
        // FIND's body matcher runs against entry CONTENT, not the pathname (the
        // path-glob is the target). Seed distinct bodies; the model FINDs the
        // entries whose content matches — never the ones it doesn't.
        await seedEntry(s.db, s.sessionId, { pathname: "fruits/apple.md", content: "a crisp autumn apple, freshly picked" });
        await seedEntry(s.db, s.sessionId, { pathname: "fruits/lemon.md", content: "a sour yellow lemon" });
        await seedEntry(s.db, s.sessionId, { pathname: "notes/todo.md", content: "buy milk and bread" });
        const { modelRunId } = await liveLoop(s, 2, { prompt: "Find every known entry whose content mentions a fruit (apple or lemon)." }, { timeoutMs: TIMEOUT });
        const rx = await lastRx(s.db, modelRunId, "FIND");
        assert.match(rx, /apple|lemon/);
        assert.doesNotMatch(rx, /todo/); // the non-fruit entry is not a content hit
    } finally { await s.cleanup(); }
});

test("live: COPY <L> — copy a line range into a new entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-copy-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "src.md", content: "one\ntwo\nthree\nfour" });
        await liveLoop(s, 2, { prompt: "Copy the second and third lines of known:///src.md into a new entry known:///slice.md." }, { timeoutMs: TIMEOUT });
        // lines 2-3 only; the trailing newline varies with the model's path
        // (a COPY slice keeps it; a READ-then-EDIT reconstruction may drop it).
        assert.match(await readBody(s.db, "slice.md") ?? "", /^two\nthree\n?$/);
    } finally { await s.cleanup(); }
});

test("live: KILL — delete an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-contract-delete-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "obsolete.md", content: "no longer needed" });
        // KILL is the canonical delete (MOVE→/dev/null retired); the model earns
        // the op from a plain delete request — we verify the entry is gone.
        await liveLoop(s, 2, { prompt: "Delete the entry known:///obsolete.md." }, { timeoutMs: TIMEOUT });
        assert.equal(await readBody(s.db, "obsolete.md"), undefined);
    } finally { await s.cleanup(); }
});
