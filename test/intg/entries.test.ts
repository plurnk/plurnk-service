import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMigrated, insertSession } from "./_helpers.ts";

const insertAgentEntry = (db: DatabaseSync, scheme: string | null, pathname: string): number => {
    const row = db
        .prepare("INSERT INTO entries (scope, scheme, pathname) VALUES ('agent', ?, ?) RETURNING id")
        .get(scheme, pathname) as { id: number };
    return row.id;
};

const insertSessionEntry = (db: DatabaseSync, sessionId: number, scheme: string | null, pathname: string): number => {
    const row = db
        .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, ?, ?) RETURNING id")
        .get(sessionId, scheme, pathname) as { id: number };
    return row.id;
};

// ---------------------------------------------------------------- entries

test("entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
    } finally { db.close(); }
});

test("entries: agent-scoped insert — session_id null, defaults populate", async () => {
    const db = await openMigrated();
    try {
        insertAgentEntry(db, "known", "philosophy/meaning");
        const row = db.prepare("SELECT * FROM entries").get() as {
            id: number; version: number; scope: string; session_id: number | null;
            scheme: string | null; pathname: string; attributes: string;
        };
        assert.equal(row.scope, "agent");
        assert.equal(row.session_id, null);
        assert.equal(row.version, 0);
        assert.equal(row.scheme, "known");
        assert.equal(row.pathname, "philosophy/meaning");
        assert.equal(row.attributes, "{}");
    } finally { db.close(); }
});

test("entries: session-scoped insert — session_id required", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-entries-session");
        insertSessionEntry(db, sessionId, "known", "foo");
        const row = db.prepare("SELECT scope, session_id FROM entries").get() as { scope: string; session_id: number };
        assert.equal(row.scope, "session");
        assert.equal(row.session_id, sessionId);
    } finally { db.close(); }
});

test("entries: scope='agent' with non-null session_id rejected by invariant CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-entries-badagent");
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, session_id, pathname) VALUES ('agent', ?, ?)").run(sessionId, "/x"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: scope='session' with null session_id rejected by invariant CHECK", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO entries (scope, pathname) VALUES ('session', '/x')"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: scope value outside enum rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO entries (scope, pathname) VALUES ('global', '/x')"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: agent-scope identity UNIQUE — duplicate (scheme, pathname) rejected", async () => {
    const db = await openMigrated();
    try {
        insertAgentEntry(db, "known", "france");
        assert.throws(
            () => insertAgentEntry(db, "known", "france"),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: session-scope identity UNIQUE — duplicate (session_id, scheme, pathname) rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-entries-dupid");
        insertSessionEntry(db, sessionId, "known", "france");
        assert.throws(
            () => insertSessionEntry(db, sessionId, "known", "france"),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: cross-scope same (scheme, pathname) is allowed — agent and session can both hold it", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-entries-crossscope");
        insertAgentEntry(db, "known", "france");
        insertSessionEntry(db, sessionId, "known", "france");
        const count = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("entries: cross-session same (scheme, pathname) is allowed — different sessions can both hold it", async () => {
    const db = await openMigrated();
    try {
        const sessionA = insertSession(db, "ws-entries-sessA");
        const sessionB = insertSession(db, "ws-entries-sessB");
        insertSessionEntry(db, sessionA, "known", "france");
        insertSessionEntry(db, sessionB, "known", "france");
        const count = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("entries: session_id FK — insert with non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, session_id, pathname) VALUES ('session', ?, '/x')").run(99999),
            /FOREIGN KEY constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: ON DELETE CASCADE via session — entries removed when session removed", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-entries-cascade");
        insertSessionEntry(db, sessionId, "known", "a");
        insertSessionEntry(db, sessionId, "known", "b");
        insertAgentEntry(db, "known", "c");
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
        assert.equal(remaining, 1, "only the agent-scoped entry should survive");
    } finally { db.close(); }
});

test("entries: scheme can be null (bare local paths)", async () => {
    const db = await openMigrated();
    try {
        insertAgentEntry(db, null, "config/foo.json");
        const row = db.prepare("SELECT scheme FROM entries").get() as { scheme: string | null };
        assert.equal(row.scheme, null);
    } finally { db.close(); }
});

test("entries: empty scheme string rejected by CHECK (length > 0 if not null)", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO entries (scope, scheme, pathname) VALUES ('agent', '', '/x')"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: port range CHECK — accepts 0..65535, rejects out-of-range", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO entries (scope, scheme, hostname, port, pathname) VALUES ('agent', 'https', 'example.com', ?, '/x')").run(443);
        db.prepare("INSERT INTO entries (scope, scheme, hostname, port, pathname) VALUES ('agent', 'https', 'example.com', ?, '/y')").run(0);
        db.prepare("INSERT INTO entries (scope, scheme, hostname, port, pathname) VALUES ('agent', 'https', 'example.com', ?, '/z')").run(65535);
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, scheme, hostname, port, pathname) VALUES ('agent', 'https', 'example.com', ?, '/w')").run(65536),
            /CHECK constraint failed/,
        );
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, scheme, hostname, port, pathname) VALUES ('agent', 'https', 'example.com', ?, '/v')").run(-1),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: params null accepted; well-formed JSON accepted; invalid JSON rejected", async () => {
    const db = await openMigrated();
    try {
        db.prepare("INSERT INTO entries (scope, pathname, params) VALUES ('agent', '/a', NULL)").run();
        db.prepare("INSERT INTO entries (scope, pathname, params) VALUES ('agent', '/b', ?)").run('{"q":["x"],"page":"2"}');
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, pathname, params) VALUES ('agent', '/c', ?)").run("{not json"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: attributes defaults to '{}' and rejects invalid JSON", async () => {
    const db = await openMigrated();
    try {
        insertAgentEntry(db, "known", "a");
        const row = db.prepare("SELECT attributes FROM entries").get() as { attributes: string };
        assert.equal(row.attributes, "{}");
        assert.throws(
            () => db.prepare("INSERT INTO entries (scope, pathname, attributes) VALUES ('agent', '/b', ?)").run("{bad"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entries: pathname NOT NULL", async () => {
    const db = await openMigrated();
    try {
        assert.throws(
            () => db.exec("INSERT INTO entries (scope) VALUES ('agent')"),
            /NOT NULL constraint failed: entries\.pathname/,
        );
    } finally { db.close(); }
});

test("entries: pathname empty string allowed", async () => {
    const db = await openMigrated();
    try {
        insertAgentEntry(db, "known", "");
        const row = db.prepare("SELECT pathname FROM entries").get() as { pathname: string };
        assert.equal(row.pathname, "");
    } finally { db.close(); }
});

test("entries: partial indexes entries_agent_identity + entries_session_identity exist", async () => {
    const db = await openMigrated();
    try {
        const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'entries_%'").all() as { name: string; sql: string }[];
        const names = indexes.map((i) => i.name).sort();
        assert.deepEqual(names, ["entries_agent_identity", "entries_session_identity"]);
        for (const idx of indexes) {
            assert.match(idx.sql, /WHERE scope = '(agent|session)'/);
            assert.match(idx.sql, /UNIQUE/);
        }
    } finally { db.close(); }
});

// ---------------------------------------------------------------- entry_channels

test("entry_channels: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entry_channels'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
        assert.match(sql, /WITHOUT ROWID/);
    } finally { db.close(); }
});

test("entry_channels: insert channel — defaults populate (tokens=0, state='static')", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, ?, ?, ?)").run(entryId, "body", "Paris is the capital.", "text/markdown");
        const row = db.prepare("SELECT * FROM entry_channels WHERE entry_id = ?").get(entryId) as {
            entry_id: number; name: string; content: string; mimetype: string; tokens: number; state: string;
        };
        assert.equal(row.name, "body");
        assert.equal(row.content, "Paris is the capital.");
        assert.equal(row.mimetype, "text/markdown");
        assert.equal(row.tokens, 0);
        assert.equal(row.state, "static");
    } finally { db.close(); }
});

test("entry_channels: (entry_id, name) UNIQUE — duplicate channel name on same entry rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "exec", "ls");
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'stdout', 'a', 'text/plain')").run(entryId);
        assert.throws(
            () => db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'stdout', 'b', 'text/plain')").run(entryId),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_channels: state enum CHECK — each value accepted; bad values rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "sse", "feed");
        for (const state of ["static", "active", "closed", "errored"]) {
            db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype, state) VALUES (?, ?, '', 'text/plain', ?)").run(entryId, `ch_${state}`, state);
        }
        assert.throws(
            () => db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype, state) VALUES (?, 'bad', '', 'text/plain', ?)").run(entryId, "draining"),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_channels: NOT NULL on name, content, mimetype", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "x");
        assert.throws(() => db.exec(`INSERT INTO entry_channels (entry_id, content, mimetype) VALUES (${entryId}, '', 'text/plain')`), /NOT NULL constraint failed: entry_channels\.name/);
        assert.throws(() => db.exec(`INSERT INTO entry_channels (entry_id, name, mimetype) VALUES (${entryId}, 'body', 'text/plain')`), /NOT NULL constraint failed: entry_channels\.content/);
        assert.throws(() => db.exec(`INSERT INTO entry_channels (entry_id, name, content) VALUES (${entryId}, 'body', '')`), /NOT NULL constraint failed: entry_channels\.mimetype/);
    } finally { db.close(); }
});

test("entry_channels: empty name or mimetype rejected by CHECK length > 0", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "y");
        assert.throws(
            () => db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, '', '', 'text/plain')").run(entryId),
            /CHECK constraint failed/,
        );
        assert.throws(
            () => db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'body', '', '')").run(entryId),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_channels: tokens negative rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "z");
        assert.throws(
            () => db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens) VALUES (?, 'body', '', 'text/plain', -1)").run(entryId),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_channels: ON DELETE CASCADE via entry — channels removed when entry removed", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "exec", "ls");
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'stdout', 'a', 'text/plain')").run(entryId);
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'stderr', 'b', 'text/plain')").run(entryId);
        db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM entry_channels").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("entry_channels: CASCADE chain session→entries→entry_channels", async () => {
    const db = await openMigrated();
    try {
        const sessionId = insertSession(db, "ws-channels-chain");
        const entryId = insertSessionEntry(db, sessionId, "known", "a");
        db.prepare("INSERT INTO entry_channels (entry_id, name, content, mimetype) VALUES (?, 'body', 'x', 'text/plain')").run(entryId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM entry_channels").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

// ---------------------------------------------------------------- entry_tags

test("entry_tags: table is STRICT and WITHOUT ROWID", async () => {
    const db = await openMigrated();
    try {
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entry_tags'").get() as { sql: string }).sql;
        assert.match(sql, /STRICT/);
        assert.match(sql, /WITHOUT ROWID/);
    } finally { db.close(); }
});

test("entry_tags: (entry_id, tag) UNIQUE — duplicate tag on same entry rejected", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(entryId, "geography");
        assert.throws(
            () => db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(entryId, "geography"),
            /UNIQUE constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_tags: same tag on different entries is fine", async () => {
    const db = await openMigrated();
    try {
        const a = insertAgentEntry(db, "known", "france");
        const b = insertAgentEntry(db, "known", "germany");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(a, "geography");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(b, "geography");
        const count = (db.prepare("SELECT COUNT(*) AS n FROM entry_tags").get() as { n: number }).n;
        assert.equal(count, 2);
    } finally { db.close(); }
});

test("entry_tags: empty tag rejected by CHECK length > 0", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "france");
        assert.throws(
            () => db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, '')").run(entryId),
            /CHECK constraint failed/,
        );
    } finally { db.close(); }
});

test("entry_tags: ON DELETE CASCADE via entry — tags removed when entry removed", async () => {
    const db = await openMigrated();
    try {
        const entryId = insertAgentEntry(db, "known", "france");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(entryId, "geography");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)").run(entryId, "europe");
        db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM entry_tags").get() as { n: number }).n;
        assert.equal(remaining, 0);
    } finally { db.close(); }
});

test("entry_tags: index entry_tags_tag enables tag-filter lookups", async () => {
    const db = await openMigrated();
    try {
        const a = insertAgentEntry(db, "known", "france");
        const b = insertAgentEntry(db, "known", "germany");
        const c = insertAgentEntry(db, "known", "japan");
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, 'europe')").run(a);
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, 'europe')").run(b);
        db.prepare("INSERT INTO entry_tags (entry_id, tag) VALUES (?, 'asia')").run(c);
        const europeEntries = db.prepare("SELECT entry_id FROM entry_tags WHERE tag = ? ORDER BY entry_id").all("europe") as { entry_id: number }[];
        assert.deepEqual(europeEntries.map((e) => e.entry_id).toSorted(), [a, b].toSorted());
        const idxRow = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='entry_tags_tag'").get() as { name: string } | undefined;
        assert.equal(idxRow?.name, "entry_tags_tag");
    } finally { db.close(); }
});
