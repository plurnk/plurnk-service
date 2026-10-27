import test from "node:test";
import { strict as assert } from "node:assert";
import { userInfo } from "node:os";
import Policy from "./policy.ts";
import SpawnAccounts, { SPAWN_USER } from "./SpawnAccount.ts";

const me = userInfo();
const answered = (stdout: string) => () => ({ status: 0, stdout });

test("{§executor-policy}: unset, bare uid[:gid], and named account resolution", () => {
    const emptyEnv = { [SPAWN_USER]: "" };
    assert.equal(SpawnAccounts.configured(emptyEnv), null);
    assert.deepEqual(SpawnAccounts.options(emptyEnv), {});
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h", USER: "u" }, emptyEnv), { HOME: "/h", USER: "u" });

    assert.deepEqual(SpawnAccounts.configured({ [SPAWN_USER]: "60007" }), { name: null, uid: 60007, gid: 60007, home: null });
    assert.deepEqual(SpawnAccounts.options({ [SPAWN_USER]: "60007:60008" }), { uid: 60007, gid: 60008 });
    assert.deepEqual(SpawnAccounts.environment({ HOME: "/h" }, { [SPAWN_USER]: "60007" }), { HOME: "/h" });

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
    assert.equal(composed.PATH, "/bin");

    assert.throws(() => SpawnAccounts.configured({ [SPAWN_USER]: "no-such-account-9c1f" }), new RegExp(`${SPAWN_USER}='no-such-account-9c1f' names no account`, "u"));
    assert.equal(Policy.isKey(SPAWN_USER), false);
});

test("{§executor-policy}: getent lookup error vs absent account vs valid record", () => {
    const missing = Object.assign(new Error("spawnSync getent ENOENT"), { code: "ENOENT" });
    const thrown = (() => { try { SpawnAccounts.resolve("alice", () => ({ error: missing, status: null, stdout: "" })); } catch (cause) { return cause as Error; } return null; })();
    assert.ok(thrown !== null);
    assert.equal(thrown.message, `${SPAWN_USER}='alice' was not resolved: the host's account lookup, \`getent passwd\`, did not run (spawnSync getent ENOENT); write uid[:gid] to name the account without a lookup.`);
    assert.equal(thrown.cause, missing);
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
    assert.throws(() => SpawnAccounts.resolve("alice", () => ({ status: 2, stdout: "" })),
        new RegExp(`^Error: ${SPAWN_USER}='alice' names no account on this host; write an account name or uid\\[:gid\\]\\.$`, "u"));
    assert.deepEqual(SpawnAccounts.resolve("alice", answered("alice:x:1001:1002:Alice A:/home/alice:/bin/sh\n")), { name: "alice", uid: 1001, gid: 1002, home: "/home/alice" });
    assert.deepEqual(SpawnAccounts.resolve("svc", answered("svc:*:498:498:::/usr/sbin/nologin\n")), { name: "svc", uid: 498, gid: 498, home: null });
    const never = (): never => { throw new Error("a bare id was looked up"); };
    assert.deepEqual(SpawnAccounts.resolve("60007:60008", never), { name: null, uid: 60007, gid: 60008, home: null });
});
