import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidateDaemonArgs } from "./candidate-daemon.mjs";
import { pinRuntime } from "./candidate-runtime.mjs";
import { resolveCandidateTopology } from "./project-topology.mjs";
import { parseCandidateClientEnv } from "./candidate-env.mjs";
import { pathToFileURL } from "node:url";
import { gateResourceEnvironment } from "./gate-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const { clientRoot, benchmarks, candidateDir } = resolveCandidateTopology(root, process.env);
mkdirSync(benchmarks, { recursive: true });
const stateDir = candidateDir === undefined
    ? mkdtempSync(resolve(benchmarks, "candidate-"))
    : candidateDir;
mkdirSync(stateDir, { recursive: true });
const dbPath = resolve(stateDir, "plurnk.db");
const clientEnv = parseCandidateClientEnv(process.env.PLURNK_CANDIDATE_CLIENT_ENV);
writeFileSync(resolve(stateDir, "command"), `${process.argv.join(" ")}\n`);

const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"})`);
    }
};

if (process.env.PLURNK_CANDIDATE_SKIP_BUILD !== "1") {
    run("npm", ["run", "build"], root);
    run("npm", ["run", "build"], clientRoot);
}
// {§candidate-pinned-runtime} — the daemon and the digest run from this copy, never the shared checkout.
const runtime = pinRuntime(root, resolve(stateDir, "runtime"));
// {§candidate-pinned-runtime} — the launcher is the pinned service's own, never the checkout's.
const { default: Launch } = await import(pathToFileURL(resolve(runtime, "plurnk-core", "dist", "launch", "Launch.js")).href);
const { default: HostPaths } = await import(pathToFileURL(resolve(runtime, "plurnk-core", "dist", "core", "HostPaths.js")).href);

// {§daemon-launch} — the pinned runtime through the service's own launcher; the database stays
// exactly where this driver retains its evidence.
let daemon;
let client;
let finalizing;
let requestedStatus;
const stop = async (child) => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((accept) => child.once("exit", accept));
    child.kill("SIGTERM");
    const graceful = await Promise.race([
        exited.then(() => true),
        new Promise((accept) => setTimeout(() => accept(false), 5_000)),
    ]);
    if (!graceful && child.exitCode === null) child.kill("SIGKILL");
    await exited;
};
const finalize = () => {
    if (finalizing !== undefined) return finalizing;
    finalizing = (async () => {
        await Promise.all([stop(client), daemon?.stop()]);
        run(process.execPath, [
            resolve(root, "scripts", "candidate-digest.mjs"),
            runtime,
            dbPath,
            resolve(stateDir, "digest"),
        ], root);
        rmSync(runtime, { recursive: true });
        process.stderr.write(`candidate artifact: ${stateDir}\n`);
    })();
    return finalizing;
};
const stopFromSignal = (status) => {
    if (requestedStatus !== undefined) return;
    requestedStatus = status;
    void finalize().then(() => process.exit(status), (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
    });
};
process.once("SIGINT", () => stopFromSignal(130));
process.once("SIGTERM", () => stopFromSignal(143));

let deadlineTimer;
let status;
let candidateError;
try {
    daemon = await Launch.start({
        command: [process.execPath, ...candidateDaemonArgs(root, runtime)],
        cwd: root,
        env: { ...await gateResourceEnvironment(new HostPaths().configFile), ...process.env, PLURNK_SERVICE_DB_PATH: dbPath },
        host: "127.0.0.1", port: 0,
        readyTimeoutMs: 30_000, stopGraceMs: 5_000,
        onOutput: (stream, chunk) => process.stderr.write(chunk),
    });
    const address = { host: daemon.host, port: String(daemon.port) };

    // bench#18 deadline snapshot: at the official budget, photograph the project
    // root and let the run play on — the harness grades both states afterwards.
    const gradeDeadlineSec = process.env.PLURNK_CANDIDATE_GRADE_DEADLINE_SEC;
    if (gradeDeadlineSec !== undefined) {
        const seconds = Number(gradeDeadlineSec);
        if (!Number.isSafeInteger(seconds) || seconds <= 0) {
            throw new Error("PLURNK_CANDIDATE_GRADE_DEADLINE_SEC must be a positive integer");
        }
        const rootFlag = process.argv.indexOf("--project-root");
        const projectRoot = rootFlag === -1 ? undefined : process.argv[rootFlag + 1];
        if (projectRoot === undefined) {
            throw new Error("PLURNK_CANDIDATE_GRADE_DEADLINE_SEC requires --project-root to snapshot");
        }
        deadlineTimer = setTimeout(() => {
            const target = resolve(stateDir, "repo@deadline");
            const copied = spawnSync("cp", ["-a", projectRoot, target], { stdio: "inherit" });
            process.stderr.write(copied.status === 0
                ? `candidate: deadline snapshot at ${seconds}s -> ${target}\n`
                : `candidate: deadline snapshot FAILED (cp status ${copied.status})\n`);
        }, seconds * 1_000);
        deadlineTimer.unref();
    }

    client = spawn(
        process.execPath,
        [resolve(clientRoot, "bin", "plurnk.js"), ...process.argv.slice(2)],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                ...clientEnv,
                PLURNK_HOST: address.host,
                PLURNK_PORT: address.port,
            },
            stdio: "inherit",
        },
    );

    status = await new Promise((accept, reject) => {
        client.once("exit", () => clearTimeout(deadlineTimer));
        client.once("error", reject);
        client.once("exit", (code, signal) => {
            if (signal !== null && requestedStatus === undefined) reject(new Error(`client terminated by ${signal}`));
            else accept(requestedStatus ?? code ?? 1);
        });
    });
} catch (error) {
    candidateError = error;
}

try {
    await finalize();
} catch (error) {
    if (candidateError !== undefined) {
        throw new AggregateError([candidateError, error], "candidate execution and finalization both failed");
    }
    throw error;
}
if (candidateError !== undefined) throw candidateError;
process.exit(status);
