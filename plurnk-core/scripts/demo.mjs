#!/usr/bin/env node

// Demo-tier driver: one entry point for the full demo sweep and the single-story
// specimen. Mirrors scripts/live.mjs, but for test/demo, and with SUBSTRING
// matching (demo test names carry spaces and punctuation, so exact-name
// collection would be ceremony). The `--test-name-pattern` flag must precede the
// file list — node silently ignores it when it follows the files — which is why
// this script exists instead of forwarding an appended flag through the inline
// npm script.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const demoDirectory = resolve(workspace, "test/demo");

export const demoFiles = async () => (await readdir(demoDirectory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => resolve(demoDirectory, name));

export const demoInvocation = async (pattern) => {
    const files = await demoFiles();
    if (files.length === 0) throw new Error("no demo stories found under test/demo");
    const operatorEnv = process.env.HOME === undefined
        ? []
        : [`--env-file-if-exists=${process.env.HOME}/.plurnk/.env`];
    return {
        args: [
            "--conditions=plurnk-dev",
            "--import=./test/floor.ts",
            "--env-file-if-exists=.env.defaults",
            ...operatorEnv,
            "--env-file-if-exists=.env",
            "--env-file-if-exists=.env.test",
            "--test",
            "--test-concurrency=1",
            ...(pattern === undefined ? [] : ["--test-name-pattern", pattern]),
            ...files,
        ],
        env: { PLURNK_SERVICE_POLICY: "../plurnk-meta/PLURNK_PERSONALITY.md" },
    };
};

const main = async () => {
    const [mode, requested, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--specimen" || requested === undefined || extra.length > 0)) {
        throw new Error("usage: npm run test:demo[:specimen] -- [name-substring]");
    }
    const { args, env } = await demoInvocation(requested);
    const child = spawn(process.execPath, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
        if (signal !== null) {
            console.error(`demo: terminated by ${signal}`);
            process.exit(1);
        }
        process.exit(code ?? 1);
    });
};

if (import.meta.main) await main();
