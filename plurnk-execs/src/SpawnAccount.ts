import { spawnSync } from "node:child_process";

export const SPAWN_USER = "PLURNK_EXECS_SPAWN_USER";

export type SpawnAccount = {
    readonly name: string | null;
    readonly uid: number;
    readonly gid: number;
    readonly home: string | null;
};

// {§executor-spawn-account} — the account every subprocess runtime spawns as. Unset, the
// daemon's own; a name is resolved once through the host's account database, `uid[:gid]`
// is taken as written. An unresolvable value is an invalid configuration at the spawn.
export default class SpawnAccounts {
    static #resolved = new Map<string, SpawnAccount>();

    static configured(env: NodeJS.ProcessEnv = process.env): SpawnAccount | null {
        const value = env[SPAWN_USER]?.trim() ?? "";
        if (value === "") return null;
        const known = SpawnAccounts.#resolved.get(value);
        if (known !== undefined) return known;
        const account = SpawnAccounts.#resolve(value);
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

    static #resolve(value: string): SpawnAccount {
        const numeric = /^(\d+)(?::(\d+))?$/u.exec(value);
        if (numeric !== null) {
            return { name: null, uid: Number(numeric[1]), gid: Number(numeric[2] ?? numeric[1]), home: null };
        }
        const lookup = spawnSync("getent", ["passwd", value], { encoding: "utf8" });
        const fields = lookup.status === 0 ? lookup.stdout.trim().split(":") : [];
        if (fields.length < 7 || fields[0] !== value) {
            throw new Error(`${SPAWN_USER}='${value}' names no account on this host; write an account name or uid[:gid].`);
        }
        return { name: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] === "" ? null : fields[5]! };
    }
}
