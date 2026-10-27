import { homedir } from "node:os";
import { join, resolve } from "node:path";

// {§test-artifact-retention} — the one resolver of the benchmark home, in plain JavaScript so the
// candidate launcher ({§share}) and every harness read it the same way: a blank
// PLURNK_BENCHMARKS is unset, `~` expands, and a relative value is the working directory's.
export const benchmarksRoot = (env = process.env) => {
    const configured = env.PLURNK_BENCHMARKS?.trim();
    const home = configured === undefined || configured.length === 0 ? "~/benchmarks" : configured;
    return resolve(home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : home);
};
