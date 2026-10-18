#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectLiveTestNames } from "../test/live-test.ts";
import HostPaths from "../src/core/HostPaths.ts";
import { gateResourceEnvironment } from "../../scripts/lib/gate-environment.mjs";
import { realModelNodeFlags } from "../../scripts/lib/environment.mjs";
import { tierRunPath } from "../../scripts/lib/test-artifacts.ts";
import { usage } from "../../scripts/lib/usage.mjs";

usage(`
usage: npm run test:live | npm run test:live:specimen -- "<exact specimen name>"   (from plurnk-core)
Drives every live specimen of the daemon, the client interface and the providers through a real model, or one specimen by its exact name ({§tier-census}).
Reads: PLURNK_MODEL and the operator environment: the login shell (credentials), .env.test, $XDG_CONFIG_HOME/plurnk/.env, .env.defaults, test/floor.ts.
Writes: <benchmark home>/tier-live-<stamp>/ with census.md and each worker's evidence.
`);

const workspace = resolve(import.meta.dirname, "..");
// Every package's live specimens: the daemon's, the client interface's and the providers' rails.
const liveDirectories = [
    resolve(workspace, "test/live"),
    resolve(workspace, "../plurnk-agui/test/live"),
    resolve(workspace, "../plurnk-providers/test/live"),
];
const reporter = resolve(workspace, "scripts/census-reporter.mjs");

export const liveFiles = async () => (await Promise.all(liveDirectories.map(async (directory) =>
    (await readdir(directory)).filter((name) => name.endsWith(".test.ts"))
        .map((name) => resolve(directory, name)))))
    .flat()
    .toSorted();

export const exactSpecimen = (requested, names) => {
    const matches = names.filter((name) => name === requested);
    if (matches.length !== 1) {
        throw new Error(`live specimen ${JSON.stringify(requested)} matched ${matches.length} registered tests; expected exactly one`);
    }
    return `^${requested.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`;
};

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

export const liveInvocation = async (requested, run) => {
    const files = await liveFiles();
    if (files.length === 0) throw new Error("no live specimens found under test/live");
    const pattern = requested === undefined
        ? undefined
        : exactSpecimen(requested, await collectLiveTestNames(files));
    return { args: tierArguments({ files, pattern, run }), env: await tierEnvironment(run) };
};

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

const main = async () => {
    const [mode, requested, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--specimen" || requested === undefined || extra.length > 0)) {
        throw new Error("usage: npm run test:live[:specimen] -- [exact test name]");
    }
    await runTier("live", await liveInvocation(requested, stampTierRun("live")));
};

if (import.meta.main) await main();
