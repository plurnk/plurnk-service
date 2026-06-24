// Live xpath/jsonpath coverage. Each test SEEDS its entry (the model never writes
// the JSON/HTML), so a green means the model actually drove the matcher — not that
// it recited a value it had just authored. The wildcard + compose-chain green the full stack —
// addressing, authority-fold (§scheme-address), matcher (verified deterministically: $.host => 200
// "db.internal"), structural <L>. The two single-value probes are RED under live gemma: the loop SENDs
// before it consumes its own READ result. Per [[never blame the model]] that's a packet question —
// deferred to the post-epic live/demo sweep (AGENTS § Demo-surfaced backlog), not a model verdict.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveSession +
// liveLoop). Seeded pathnames are slash-prefixed (the RFC-3986 path the parser
// resolves known:///x.json to), so seed and the model's READ can't drift.

import test from "node:test";
import assert from "node:assert/strict";
import { liveSession, liveLoop, seedEntry } from "../_live-harness.ts";

const TIMEOUT = Number(process.env.PLURNK_LIVE_TIMEOUT ?? 240_000); // raise for slow/remote endpoints

test("live: jsonpath $.field on known:///config.json extracts a value", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-jsonpath-field-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/config.json", content: '{"host":"db.internal","pool":5}', mimetype: "application/json" });
        const prompt = [
            "Two-step probe. The entry known:///config.json already holds a JSON object with host and pool fields.",
            "1) <<READ(known:///config.json):$.host:READ",
            "2) <<SEND[200]:<the host value>:SEND",
        ].join("\n");
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /db\.internal/);
    } finally { await s.cleanup(); }
});

test("live: jsonpath $.users[*].name wildcard extracts list", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-jsonpath-wildcard-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const prompt = [
            "Two-step probe. The entry known:///team.json already holds a JSON object with a users array.",
            "1) <<READ(known:///team.json):$.users[*].name:READ",
            "2) <<SEND[200]:<both names in any form>:SEND",
        ].join("\n");
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
        assert.match(lastContent, /Bob/);
    } finally { await s.cleanup(); }
});

test("live: xpath //h1/text() on known:///page.html extracts heading text", { timeout: TIMEOUT }, async () => {
    const s = await liveSession({ name: `live-xpjp-xpath-h1-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/page.html", content: "<html><body><h1>Welcome</h1></body></html>", mimetype: "text/html" });
        const prompt = [
            "Two-step probe. The entry known:///page.html already holds an HTML page with an h1 heading.",
            "1) <<READ(known:///page.html)://h1/text():READ",
            "2) <<SEND[200]:<the h1 text>:SEND",
        ].join("\n");
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Welcome/);
    } finally { await s.cleanup(); }
});

test("live: jsonpath compose-chain — extract then pick first via structural <L>", { timeout: TIMEOUT }, async () => {
    // Exercises the killer composition: matcher result is JSON; structural
    // <L> on the log entry picks the Nth match without jsonpath syntax.
    const s = await liveSession({ name: `live-xpjp-compose-jsonpath-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.sessionId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const prompt = [
            "Three-step probe. The entry known:///team.json already holds a JSON object with a users array.",
            "1) <<READ(known:///team.json):$.users[*].name:READ",
            "   (the result lands at log:///1/1/2 as a JSON array of match rows)",
            "2) <<READ(log:///1/1/2)<1>::READ",
            "   (structural <L> picks the 1st match; result is [{line,matched:Alice}])",
            "3) <<SEND[200]:Alice:SEND",
        ].join("\n");
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt }, { timeoutMs: TIMEOUT });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
    } finally { await s.cleanup(); }
});
