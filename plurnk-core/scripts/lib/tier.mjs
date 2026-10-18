// What the live and demo drivers share: the run stamp, the node:test invocation, the environment
// and the spawn. A module, so that neither driver imports the other ({§scripts-layout}).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import HostPaths from "../../src/core/HostPaths.ts";
import { gateResourceEnvironment } from "../../../scripts/lib/gate-environment.mjs";
import { realModelNodeFlags } from "../../../scripts/lib/environment.mjs";
import { tierRunPath } from "../../../scripts/lib/test-artifacts.ts";

const workspace = resolve(import.meta.dirname, "../..");
const reporter = resolve(import.meta.dirname, "census-reporter.mjs");

// {§tier-census} — a run is stamped once by the driver: `<kind>-<UTC stamp>` names the directory every
// worker lands in and the census the reporter writes there.
export const stampTierRun = (kind, now = new Date()) =>
    `${kind}-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

// The node:test invocation the tier and its single-specimen form share. A stamped run adds the
// census reporter beside the console's spec reporter; an unstamped one (the driver's own tests) does not.
export const tierArguments = ({ files, pattern, run }) => [
    "--conditions=plurnk-dev",
    ...realModelNodeFlags(resolve(workspace, ".."), { operatorFile: new HostPaths().configFile }),
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    ...(run === undefined ? [] : [`--test-reporter=${reporter}`, `--test-reporter-destination=${join(tierRunPath(run), "census.md")}`]),
    ...(pattern === undefined ? [] : ["--test-name-pattern", pattern]),
    ...files,
];

export const tierEnvironment = async (run) => ({
    ...await gateResourceEnvironment(new HostPaths().configFile),
    PLURNK_SERVICE_POLICY: "../plurnk-meta/POLICY.md",
    ...(run === undefined ? {} : { PLURNK_TIER_RUN: run }),
});

// Spawn the tier under its stamp and exit as it exits; the reporter has written the census by then.
export const runTier = async (kind, { args, env }) => {
    await mkdir(tierRunPath(env.PLURNK_TIER_RUN), { recursive: true });
    const child = spawn(process.execPath, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
        if (signal !== null) {
            console.error(`${kind}: terminated by ${signal}`);
            process.exit(1);
        }
        process.exit(code ?? 1);
    });
};
