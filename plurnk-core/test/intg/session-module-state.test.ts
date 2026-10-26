// SPEC {§module-workspace-state} — a family declares whether its definitions belong to the
// workspace or to a session, and the coordinator keys state by that scope. `env` is the first
// session-scoped family: an environment is context (how this session works) rather than capability
// (what exists in this workspace).
//
// A sibling table rather than a nullable column, so the foreign key is real. These witnesses
// cover the two properties that choice buys: isolation between sessions, and a cascade that takes
// a session's definitions with it.

import test from "node:test";
import assert from "node:assert/strict";
import { openMigrated, insertWorkspace, insertSession } from "./_db.ts";

const OWNER = "@plurnk/plurnk-service";

test("{§module-workspace-state} session state is per session, not shared across siblings", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-${crypto.randomUUID()}`);
        const one = await insertSession(db, workspaceId);
        const two = await insertSession(db, workspaceId);

        await db.session_module_state_put.run({
            session_id: one, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { CARGO_TARGET_DIR: { origin: "session", enabled: true } } }),
        });

        const mine = await db.session_module_state_get.get<{ state: string }>({ session_id: one, namespace_owner: OWNER });
        const sibling = await db.session_module_state_get.get<{ state: string }>({ session_id: two, namespace_owner: OWNER });
        assert.match(mine!.state, /CARGO_TARGET_DIR/u);
        assert.equal(sibling, undefined, "a sibling session sees nothing of it — this is the whole reason for the scope");
    } finally { await db.close(); }
});

test("{§module-workspace-state} a session's definitions die with the session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-cascade-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await db.session_module_state_put.run({
            session_id: sessionId, namespace_owner: OWNER, state: JSON.stringify({ version: 1, definitions: {} }),
        });

        await db.test_delete_session.run({ id: sessionId });

        const orphan = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
        assert.equal(orphan, undefined, "the real foreign key cascades; a nullable column on the workspace table would have orphaned it");
    } finally { await db.close(); }
});

test("{§module-workspace-state} put replaces in place, keyed by (session, owner)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-replace-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const key = { session_id: sessionId, namespace_owner: OWNER };
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { A: {} } }) });
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { B: {} } }) });

        const row = await db.session_module_state_get.get<{ state: string }>(key);
        assert.match(row!.state, /"B"/u);
        assert.doesNotMatch(row!.state, /"A"/u, "one snapshot per (session, owner), replaced whole");
    } finally { await db.close(); }
});

// {§functionality-scope} — inheritance is a row copy at the child's creation, marked with its source.
const definitionsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<Record<string, Record<string, unknown>>> => {
    const row = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
    return row === undefined ? {} : (JSON.parse(row.state) as { definitions: Record<string, Record<string, unknown>> }).definitions;
};

test("{§functionality-scope} a child starts with a copy of its parent's state, every entry named for its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-inherit-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice");
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: {
                CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
                CI: { origin: "service", enabled: false },
            } }),
        });
        const bob = await insertSession(db, workspaceId, alice, "bob");
        assert.deepEqual(await definitionsOf(db, bob), {
            CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" }, inherited: "alice" },
            CI: { origin: "service", enabled: false, inherited: "alice" },
        }, "copied faithfully, disabled entries included, each named for the Session that set it");

        // A snapshot, not a link: alice's later edit never reaches bob.
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { LATER: { origin: "session", enabled: true, definition: { value: "x" } } } }),
        });
        assert.deepEqual(Object.keys(await definitionsOf(db, bob)), ["CARGO_TARGET_DIR", "CI"]);

        // Depth is transitive and provenance names the origin, not the intermediate.
        const carol = await insertSession(db, workspaceId, bob, "carol");
        assert.equal((await definitionsOf(db, carol)).CARGO_TARGET_DIR.inherited, "alice", "a grandchild still names the Session that set the entry");

        // A parentless Session inherits nothing.
        const loner = await insertSession(db, workspaceId, null, "loner");
        assert.deepEqual(await definitionsOf(db, loner), {});
    } finally { await db.close(); }
});
