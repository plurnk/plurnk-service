#!/usr/bin/env node

// Demo-tier driver: one entry point for the full demo sweep and the single-story
// specimen. Mirrors scripts/live.mjs, but for test/demo, and with PATTERN
// matching (demo test names carry spaces and punctuation, so exact-name
// selection would be ceremony); the pattern must select at least one registered
// story, so a misspelled selector fails before any provider is called (#597). The `--test-name-pattern` flag must precede the
// file list — node silently ignores it when it follows the files — which is why
// this script exists instead of forwarding an appended flag through the inline
// npm script.

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { collectLiveTestNames } from "../test/live-test.ts";
import { runTier, stampTierRun, tierArguments, tierEnvironment } from "./lib/tier.mjs";
import { usage } from "../../scripts/lib/usage.mjs";

usage(import.meta, `
usage: npm run test:demo [-- --specimen <story-name-pattern>]   (from plurnk-core)
Drives the demo stories through a real model, every story or the ones a pattern selects; the pattern must select at least one ({§tier-census}).
Reads: PLURNK_MODEL and the operator environment: the login shell (credentials), .env.test, $XDG_CONFIG_HOME/plurnk/.env, .env.defaults, test/floor.ts.
Writes: <benchmark home>/tier-demo-<stamp>/ with census.md and each session's evidence.
`);

const workspace = resolve(import.meta.dirname, "..");
const demoDirectory = resolve(workspace, "test/demo");

export const demoFiles = async () => (await readdir(demoDirectory))
    .filter((name) => name.endsWith(".test.ts"))
    .toSorted()
    .map((name) => resolve(demoDirectory, name));

// A selector is what node's --test-name-pattern makes of it: a regular expression tested against
// every registered story name. It must be a pattern and it must select at least one story; a
// green run that ran nothing is the failure this refuses (#597).
export const matchingStories = (selector, names) => {
    let pattern;
    try { pattern = new RegExp(selector); }
    catch (cause) { throw new Error(`demo specimen ${JSON.stringify(selector)} is not a valid pattern: ${cause.message}`, { cause }); }
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length === 0) {
        throw new Error(`demo specimen ${JSON.stringify(selector)} matches no registered story; registered:\n  ${names.join("\n  ")}`);
    }
    return matches;
};

export const demoInvocation = async (pattern, run) => {
    const files = await demoFiles();
    if (files.length === 0) throw new Error("no demo stories found under test/demo");
    if (pattern !== undefined) matchingStories(pattern, await collectLiveTestNames(files));
    return { args: tierArguments({ files, pattern, run }), env: await tierEnvironment(run) };
};

const main = async () => {
    const [mode, requested, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--specimen" || requested === undefined || extra.length > 0)) {
        throw new Error("usage: npm run test:demo [-- --specimen <story-name-pattern>]");
    }
    await runTier("demo", await demoInvocation(requested, stampTierRun("demo")));
};

if (import.meta.main) await main();
