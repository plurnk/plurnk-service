#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { evaluateOrientation } from "./orientation-verdict.mjs";

const serviceRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(process.env.PLURNK_ACCEPTANCE_PROJECT_ROOT ?? resolve(serviceRoot, ".."));
const clientRoot = resolve(process.env.PLURNK_CLIENT_CHECKOUT ?? resolve(projectRoot, "repo", "plurnk"));
const benchmarksRoot = resolve(process.env.PLURNK_BENCHMARKS ?? resolve(projectRoot, "benchmarks"));
const prompt = readFileSync(resolve(import.meta.dirname, "fixtures", "orientation-prompt.md"), "utf8").trim();

const usage = "usage: npm run acceptance:orientation -- --model <alias> [--requiem] [--preserve]";
const args = process.argv.slice(2);
const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
};
const model = valueAfter("--model");
if (model === undefined || model.startsWith("--")) {
    process.stderr.write(`${usage}\n`);
    process.exit(64);
}
const requiem = args.includes("--requiem");
const preservePassing = args.includes("--preserve");
const unknown = args.filter((arg, index) =>
    arg !== "--requiem"
    && arg !== "--preserve"
    && arg !== "--model"
    && args[index - 1] !== "--model");
if (unknown.length > 0) {
    process.stderr.write(`unknown option: ${unknown[0]}\n${usage}\n`);
    process.exit(64);
}

const run = (command, commandArgs, cwd, options = {}) => {
    const started = Date.now();
    const result = spawnSync(command, commandArgs, {
        cwd,
        encoding: "utf8",
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) throw result.error;
    return {
        command: [command, ...commandArgs],
        cwd,
        status: result.status ?? 1,
        wallMs: Date.now() - started,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
};

const claimRunDir = () => {
    mkdirSync(benchmarksRoot, { recursive: true });
    let n = 1;
    for (const name of existsSync(benchmarksRoot) ? readFileNames(benchmarksRoot) : []) {
        const match = /^run(\d+)-/.exec(name);
        if (match !== null) n = Math.max(n, Number(match[1]) + 1);
    }
    for (;;) {
        const path = resolve(benchmarksRoot, `run${n}-orientation`);
        try {
            mkdirSync(path);
            return path;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            n += 1;
        }
    }
};

const readFileNames = (path) => {
    const result = spawnSync("find", [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\n"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.split("\n").filter(Boolean);
};

const workDir = mkdtempSync(resolve(tmpdir(), "plurnk-orientation-"));
const dbPath = resolve(workDir, "plurnk.db");
const digestDir = resolve(workDir, "digest");
const phases = [];
let daemon;
let daemonExit;

const stopDaemon = async () => {
    if (daemon === undefined || daemon.exitCode !== null) return;
    daemon.kill("SIGTERM");
    await Promise.race([
        daemonExit,
        new Promise((accept) => setTimeout(() => {
            if (daemon.exitCode === null) daemon.kill("SIGKILL");
            accept();
        }, 10_000)),
    ]);
};

const preserve = (verdict) => {
    const keep = preservePassing || !verdict.pass;
    if (!keep) {
        rmSync(workDir, { recursive: true, force: true });
        return null;
    }
    const destination = claimRunDir();
    rmSync(destination, { recursive: true, force: true });
    cpSync(workDir, destination, { recursive: true });
    rmSync(workDir, { recursive: true, force: true });
    return destination;
};

try {
    for (const [cwd, label] of [[serviceRoot, "service-build"], [clientRoot, "client-build"]]) {
        const phase = run("npm", ["run", "build"], cwd);
        phases.push({ label, command: phase.command, cwd, status: phase.status, wallMs: phase.wallMs });
        appendFileSync(resolve(workDir, `${label}.stdout.log`), phase.stdout);
        appendFileSync(resolve(workDir, `${label}.stderr.log`), phase.stderr);
        if (phase.status !== 0) throw new Error(`${label} failed`);
    }

    const daemonOut = resolve(workDir, "service.stdout.log");
    const daemonErr = resolve(workDir, "service.stderr.log");
    const daemonStarted = Date.now();
    daemon = spawn(process.execPath, [resolve(serviceRoot, "plurnk-core", "dist", "service.js"), "start"], {
        cwd: serviceRoot,
        env: {
            ...process.env,
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_MODEL: model,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    daemonExit = new Promise((accept) => daemon.once("exit", (code, signal) => accept({ code, signal })));
    let startup = "";
    daemon.stdout.setEncoding("utf8");
    daemon.stderr.setEncoding("utf8");
    daemon.stdout.on("data", (chunk) => {
        startup += chunk;
        appendFileSync(daemonOut, chunk);
    });
    daemon.stderr.on("data", (chunk) => appendFileSync(daemonErr, chunk));

    const address = await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error("daemon did not publish its AG-UI address within 30 seconds")), 30_000);
        const inspect = () => {
            const match = startup.match(/agui=http:\/\/([^:]+):(\d+)/);
            if (match === null) return;
            clearTimeout(timeout);
            accept({ host: match[1], port: match[2] });
        };
        daemon.stdout.on("data", inspect);
        daemon.once("exit", (code) => reject(new Error(`daemon exited during startup (status ${code})`)));
    });
    phases.push({ label: "daemon-start", status: 0, wallMs: Date.now() - daemonStarted });

    const workspace = `orientation-${Date.now()}`;
    writeFileSync(resolve(workDir, "workspace"), `${workspace}\n`);
    writeFileSync(resolve(workDir, "prompt.md"), `${prompt}\n`);
    const client = run(process.execPath, [
        resolve(clientRoot, "bin", "plurnk.js"),
        "--json",
        "--workspace", workspace,
        "--worker", "meta",
        "--model", model,
        "--project-root", projectRoot,
        "--repo", "**",
        "--auto",
        "--timeout", process.env.PLURNK_ACCEPTANCE_TIMEOUT ?? "900",
        prompt,
    ], projectRoot, {
        env: {
            ...process.env,
            PLURNK_HOST: address.host,
            PLURNK_PORT: address.port,
            PLURNK_AGUI_URL: `http://${address.host}:${address.port}`,
        },
    });
    phases.push({ label: "client", command: client.command, cwd: client.cwd, status: client.status, wallMs: client.wallMs });
    writeFileSync(resolve(workDir, "client.json"), client.stdout);
    writeFileSync(resolve(workDir, "client.stderr.log"), client.stderr);

    await stopDaemon();
    const digest = run(process.execPath, [
        "--conditions=plurnk-dev",
        resolve(serviceRoot, "plurnk-core", "bin", "digest.ts"),
        dbPath,
        digestDir,
        ...(requiem ? ["--requiem"] : []),
    ], serviceRoot, { env: { ...process.env, PLURNK_MODEL: model } });
    phases.push({ label: requiem ? "digest+requiem" : "digest", command: digest.command, cwd: digest.cwd, status: digest.status, wallMs: digest.wallMs });
    writeFileSync(resolve(workDir, "digest.stdout.log"), digest.stdout);
    writeFileSync(resolve(workDir, "digest.stderr.log"), digest.stderr);

    let verdict;
    try {
        const record = JSON.parse(client.stdout);
        const digestJson = JSON.parse(readFileSync(resolve(digestDir, "digest.json"), "utf8"));
        verdict = evaluateOrientation(record, digestJson);
    } catch (error) {
        verdict = {
            schemaVersion: 1,
            pass: false,
            failed: ["artifacts"],
            error: error instanceof Error ? error.message : String(error),
        };
    }
    if (client.status !== 0 || digest.status !== 0) {
        verdict.pass = false;
        verdict.failed = [...new Set([...(verdict.failed ?? []), client.status !== 0 ? "clientProcess" : null, digest.status !== 0 ? "digestProcess" : null].filter(Boolean))];
    }
    writeFileSync(resolve(workDir, "phases.json"), `${JSON.stringify(phases, null, 2)}\n`);
    writeFileSync(resolve(workDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
    const kept = preserve(verdict);
    process.stdout.write(`${JSON.stringify({ ...verdict, specimen: kept }, null, 2)}\n`);
    process.exitCode = verdict.pass ? 0 : 1;
} catch (error) {
    await stopDaemon();
    const verdict = {
        schemaVersion: 1,
        pass: false,
        failed: ["runner"],
        error: error instanceof Error ? error.message : String(error),
    };
    writeFileSync(resolve(workDir, "phases.json"), `${JSON.stringify(phases, null, 2)}\n`);
    writeFileSync(resolve(workDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
    const kept = preserve(verdict);
    process.stderr.write(`${verdict.error}\nspecimen: ${kept}\n`);
    process.exitCode = 1;
}
