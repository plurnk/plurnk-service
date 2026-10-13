import test from "node:test";
import { strict as assert } from "node:assert";
import os from "node:os";
import SpawnAccounts, { SPAWN_USER } from "./SpawnAccount.ts";
import Policy from "./policy.ts";

const me = os.userInfo();

test("{§executor-spawn-account}: unset, the daemon's own account — no spawn identity and the environment as handed", () => {
    const env = { [SPAWN_USER]: "" };
    assert.equal(SpawnAccounts.configured(env), null);
    assert.deepEqual(SpawnAccounts.options(env), {});
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h", USER: "u" }, env), { HOME: "/h", USER: "u" });
});

test("{§executor-spawn-account}: a bare uid[:gid] is taken as written and leaves the environment alone", () => {
    assert.deepEqual(SpawnAccounts.configured({ [SPAWN_USER]: "60007" }), { name: null, uid: 60007, gid: 60007, home: null });
    assert.deepEqual(SpawnAccounts.options({ [SPAWN_USER]: "60007:60008" }), { uid: 60007, gid: 60008 });
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h" }, { [SPAWN_USER]: "60007" }), { HOME: "/h" });
});

test("{§executor-spawn-account}: a name resolves through the host's account database, and the child's environment names it", () => {
    const env = { [SPAWN_USER]: me.username };
    const account = SpawnAccounts.configured(env);
    assert.ok(account !== null);
    assert.equal(account.name, me.username);
    assert.equal(account.uid, me.uid);
    assert.equal(account.gid, me.gid);
    assert.deepEqual(SpawnAccounts.options(env), { uid: me.uid, gid: me.gid });
    const composed = SpawnAccounts.environment({ HOME: "/elsewhere", PATH: "/bin" }, env);
    assert.equal(composed.USER, me.username);
    assert.equal(composed.LOGNAME, me.username);
    assert.equal(composed.HOME, account.home ?? "/elsewhere");
    assert.equal(composed.PATH, "/bin", "the composed environment is kept; only the account's names change");
});

test("{§executor-spawn-account}: a value naming no account is an invalid configuration named by its knob", () => {
    assert.throws(() => SpawnAccounts.configured({ [SPAWN_USER]: "no-such-account-9c1f" }), new RegExp(`${SPAWN_USER}='no-such-account-9c1f' names no account`, "u"));
});

test("{§executor-spawn-account} {§executor-policy}: the knob sits outside the runtime policy-key grammar", () => {
    assert.equal(Policy.isKey(SPAWN_USER), false);
});

// The lookup outcomes below are simulated answers of `getent passwd`; the two tests above ask the
// real database of this host. No Darwin or BSD host verified any of them.
const answered = (stdout: string) => () => ({ status: 0, stdout });

test("{§executor-spawn-account}: a lookup that did not run, failed, or answered another record is not resolved, and is never reported as an absent account", () => {
    const missing = Object.assign(new Error("spawnSync getent ENOENT"), { code: "ENOENT" });
    const thrown = (() => { try { SpawnAccounts.resolve("alice", () => ({ error: missing, status: null, stdout: "" })); } catch (cause) { return cause as Error; } return null; })();
    assert.ok(thrown !== null);
    assert.equal(thrown.message, `${SPAWN_USER}='alice' was not resolved: the host's account lookup, \`getent passwd\`, did not run (spawnSync getent ENOENT); write uid[:gid] to name the account without a lookup.`);
    assert.equal(thrown.cause, missing, "the host's own error is kept as the cause");
    const failures: ReadonlyArray<readonly [string, ReturnType<Parameters<typeof SpawnAccounts.resolve>[1] & {}>, RegExp]> = [
        ["exited otherwise", { status: 1, stdout: "" }, /was not resolved: .* exited 1;/u],
        ["ended by a signal", { status: null, signal: "SIGKILL", stdout: "" }, /was not resolved: .* was ended by SIGKILL;/u],
        ["empty answer", { status: 0, stdout: "" }, /answered a record that is not this account's/u],
        ["another account's record", { status: 0, stdout: "bob:x:1001:1001::/home/bob:/bin/sh\n" }, /answered a record that is not this account's/u],
        ["a record without numeric ids", { status: 0, stdout: "alice:x:uid:gid::/home/alice:/bin/sh\n" }, /answered a record that is not this account's/u],
        ["a short record", { status: 0, stdout: "alice:x:1001\n" }, /answered a record that is not this account's/u],
    ];
    for (const [label, answer, expected] of failures) {
        assert.throws(() => SpawnAccounts.resolve("alice", () => answer), (error: unknown) =>
            error instanceof Error && expected.test(error.message) && !/names no account/u.test(error.message), label);
    }
});

test("{§executor-spawn-account}: only the database's own 'not in the database' answer names no account", () => {
    assert.throws(() => SpawnAccounts.resolve("alice", () => ({ status: 2, stdout: "" })),
        new RegExp(`^Error: ${SPAWN_USER}='alice' names no account on this host; write an account name or uid\\[:gid\\]\\.$`, "u"));
});

test("{§executor-spawn-account}: a record is read as name, uid, gid and home; a bare id never asks the database", () => {
    assert.deepEqual(SpawnAccounts.resolve("alice", answered("alice:x:1001:1002:Alice A:/home/alice:/bin/sh\n")), { name: "alice", uid: 1001, gid: 1002, home: "/home/alice" });
    assert.deepEqual(SpawnAccounts.resolve("svc", answered("svc:*:498:498:::/usr/sbin/nologin\n")), { name: "svc", uid: 498, gid: 498, home: null }, "an empty home is no home");
    const never = (): never => { throw new Error("a bare id was looked up"); };
    assert.deepEqual(SpawnAccounts.resolve("60007:60008", never), { name: null, uid: 60007, gid: 60008, home: null });
});
