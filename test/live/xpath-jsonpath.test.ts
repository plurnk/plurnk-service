// Live xpath/jsonpath coverage. Each test SEEDS its entry (the model never writes the JSON/HTML),
// then asks a NATURAL question whose answer requires extracting from that entry — and asserts the
// OUTCOME (the value), never the path. The model drives the matcher (jsonpath/xpath) and any pick
// itself; we do NOT script ops or hardcode log coordinates. Coordinates shift with the foist and no
// real task names them — scripting them made these brittle (and wrong: a hardcoded log:///1/1/2 was
// the prompt-foist EDIT, not the model's result). The matcher MECHANICS are pinned deterministically
// in intg; this tier proves gemma actually answers real extraction questions through the prod loop
// (loop.run via the daemon — liveSession + liveLoop). Seeded pathnames are slash-prefixed (the
// RFC-3986 path the parser resolves known:///x.json to), so seed and the model's READ can't drift.

import test from "node:test";
import assert from "node:assert/strict";
import { liveSession, liveLoop, seedEntry } from "../_live-harness.ts";

const TIMEOUT = Number(process.env.PLURNK_LIVE_TIMEOUT ?? 240_000); // raise for slow/remote endpoints

test("live: model answers a JSON field question (jsonpath extraction)", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-jsonpath-field-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/config.json", content: '{"host":"db.internal","pool":5}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "What is the value of the `host` field in known:///config.json?" }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /db\.internal/);
    } finally { await s.cleanup(); }
});

test("live: model lists every value from a JSON array (jsonpath wildcard)", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-jsonpath-wildcard-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "List the names of every user in known:///team.json." }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
        assert.match(lastContent, /Bob/);
    } finally { await s.cleanup(); }
});

test("live: model answers an HTML heading question (xpath extraction)", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-xpath-h1-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/page.html", content: "<html><body><h1>Welcome</h1></body></html>", mimetype: "text/html" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "What does the h1 heading in known:///page.html say?" }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Welcome/);
    } finally { await s.cleanup(); }
});

test("live: model picks the first item out of a JSON array (extract then pick first)", { timeout: TIMEOUT }, async () => {
    // The natural form of the old compose-chain: the answer requires extracting the user names and
    // taking the first — however the model chooses to get there. No scripted ops, no log coordinates.
    const s = await liveSession({ name: `live-xpjp-compose-first-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "Who is the first user listed in known:///team.json?" }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
    } finally { await s.cleanup(); }
});
