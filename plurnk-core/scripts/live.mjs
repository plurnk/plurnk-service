#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { collectLiveTestNames } from "../test/live-test.ts";
import HostPaths from "../src/core/HostPaths.ts";

const workspace = resolve(import.meta.dirname, "..");
const liveDirectory = resolve(workspace, "test/live");

export const liveFiles = async () => (await readdir(liveDirectory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => resolve(liveDirectory, name));

export const exactSpecimen = (requested, names) => {
    const matches = names.filter((name) => name === requested);
    if (matches.length !== 1) {
        throw new Error(`live specimen ${JSON.stringify(requested)} matched ${matches.length} registered tests; expected exactly one`);
    }
    return `^${requested.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`;
};

export const liveInvocation = async (requested) => {
    const files = await liveFiles();
    if (files.length === 0) throw new Error("no live specimens found under test/live");
    const pattern = requested === undefined
        ? undefined
        : exactSpecimen(requested, await collectLiveTestNames(files));
    const operatorEnv = [`--env-file-if-exists=${new HostPaths().configFile}`];
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
        env: { PLURNK_SERVICE_POLICY: "../plurnk-meta/POLICY.md" },
    };
};

const main = async () => {
    const [mode, requested, ...extra] = process.argv.slice(2);
    if (mode !== undefined && (mode !== "--specimen" || requested === undefined || extra.length > 0)) {
        throw new Error("usage: npm run test:live[:specimen] -- [exact test name]");
    }
    const { args, env } = await liveInvocation(requested);
    const child = spawn(process.execPath, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
        if (signal !== null) {
            console.error(`live: terminated by ${signal}`);
            process.exit(1);
        }
        process.exit(code ?? 1);
    });
};

if (import.meta.main) await main();
