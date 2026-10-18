#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { collectLiveTestNames } from "../test/live-test.ts";
import { runTier, stampTierRun, tierArguments, tierEnvironment } from "./lib/tier.mjs";
import { usage } from "../../scripts/lib/usage.mjs";

usage(import.meta, `
usage: npm run test:live [-- --specimen "<exact specimen name>"]   (from plurnk-core)
Drives every live specimen of the daemon, the client interface and the providers through a real model, or one specimen by its exact name ({§tier-census}); the names are the test titles under plurnk-core/test/live, plurnk-agui/test/live and plurnk-providers/test/live.
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

export const liveInvocation = async (requested, run) => {
    const files = await liveFiles();
    if (files.length === 0) throw new Error("no live specimens found under test/live");
    const pattern = requested === undefined
        ? undefined
        : exactSpecimen(requested, await collectLiveTestNames(files));
    return { args: tierArguments({ files, pattern, run }), env: await tierEnvironment(run) };
};

const main = async () => {
    const [mode, requested, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--specimen" || requested === undefined || extra.length > 0)) {
        throw new Error('usage: npm run test:live [-- --specimen "<exact specimen name>"]');
    }
    await runTier("live", await liveInvocation(requested, stampTierRun("live")));
};

if (import.meta.main) await main();
