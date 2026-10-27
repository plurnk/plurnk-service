import { spawnSync } from "node:child_process";

export const SPAWN_USER = "PLURNK_EXECS_SPAWN_USER";

export type SpawnAccount = {
    readonly name: string | null;
    readonly uid: number;
    readonly gid: number;
    readonly home: string | null;
};

/** What the host's account lookup answered: the fields of `spawnSync` this resolver reads. */
export type AccountLookup = (name: string) => {
    readonly error?: Error;
    readonly status: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly stdout: string;
};

// getent(1): 2 is "the key is not in the database", distinct from a lookup that failed.
const GETENT_ABSENT = 2;
const getent: AccountLookup = (name) => spawnSync("getent", ["passwd", name], { encoding: "utf8" });

// {§executor-policy} — the account every subprocess runtime spawns as. Unset, the
// daemon's own; a name is resolved once through the host's account database, `uid[:gid]`
// is taken as written. An unresolvable value is an invalid configuration at the spawn.
export default class SpawnAccounts {
    static #resolved = new Map<string, SpawnAccount>();

    static configured(env: NodeJS.ProcessEnv = process.env): SpawnAccount | null {
        const value = env[SPAWN_USER]?.trim() ?? "";
        if (value === "") return null;
        const known = SpawnAccounts.#resolved.get(value);
        if (known !== undefined) return known;
        const account = SpawnAccounts.resolve(value);
        SpawnAccounts.#resolved.set(value, account);
        return account;
    }

    // spawn options: the identity the child runs as, or nothing.
    static options(env: NodeJS.ProcessEnv = process.env): { uid?: number; gid?: number } {
        const account = SpawnAccounts.configured(env);
        return account === null ? {} : { uid: account.uid, gid: account.gid };
    }

    // The child's environment names the account it runs as: HOME, USER and LOGNAME follow the
    // account when it was resolved by name; a bare id leaves the composed environment as handed.
    static environment(base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
        const account = SpawnAccounts.configured(env);
        if (account === null || account.name === null) return base;
        return { ...base, ...(account.home === null ? {} : { HOME: account.home }), USER: account.name, LOGNAME: account.name };
    }

    // One value resolved, uncached. A lookup that did not run or did not answer says nothing about
    // the account, so it is never reported as an absent one.
    static resolve(value: string, lookup: AccountLookup = getent): SpawnAccount {
        const numeric = /^(\d+)(?::(\d+))?$/u.exec(value);
        if (numeric !== null) {
            return { name: null, uid: Number(numeric[1]), gid: Number(numeric[2] ?? numeric[1]), home: null };
        }
        const answer = lookup(value);
        const unresolved = (what: string, cause?: Error): Error => new Error(
            `${SPAWN_USER}='${value}' was not resolved: the host's account lookup, \`getent passwd\`, ${what}; write uid[:gid] to name the account without a lookup.`,
            cause === undefined ? undefined : { cause },
        );
        if (answer.error !== undefined) throw unresolved(`did not run (${answer.error.message})`, answer.error);
        if (answer.status === GETENT_ABSENT) {
            throw new Error(`${SPAWN_USER}='${value}' names no account on this host; write an account name or uid[:gid].`);
        }
        if (answer.status !== 0) throw unresolved(answer.status === null ? `was ended by ${answer.signal ?? "a signal"}` : `exited ${answer.status}`);
        const fields = answer.stdout.trim().split(":");
        if (fields.length < 7 || fields[0] !== value || !/^\d+$/u.test(fields[2]) || !/^\d+$/u.test(fields[3])) {
            throw unresolved("answered a record that is not this account's");
        }
        return { name: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] === "" ? null : fields[5] };
    }
}
