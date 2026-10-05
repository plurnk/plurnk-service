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
