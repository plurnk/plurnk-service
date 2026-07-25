import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const clientRoot = resolve(process.env.PLURNK_CLIENT_CHECKOUT ?? resolve(root, "..", "plurnk"));
const benchmarks = resolve(process.env.PLURNK_BENCHMARKS ?? resolve(root, "..", "..", "benchmarks"));
mkdirSync(benchmarks, { recursive: true });
const stateDir = mkdtempSync(resolve(benchmarks, "candidate-"));
const dbPath = resolve(stateDir, "plurnk.db");
writeFileSync(resolve(stateDir, "command"), `${process.argv.join(" ")}\n`);

const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
};

run("npm", ["run", "build"], root);
run("npm", ["run", "build"], clientRoot);

const daemon = spawn(
    process.execPath,
    [resolve(root, "plurnk-core", "dist", "service.js"), "start"],
    {
        cwd: root,
        env: {
            ...process.env,
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_MODEL: process.env.PLURNK_CANDIDATE_MODEL ?? "",
        },
        stdio: ["ignore", "pipe", "inherit"],
    },
);

let client;
let finalizing;
const stop = async (child) => {
    if (child === undefined || child.exitCode !== null) return;
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
        await Promise.all([stop(client), stop(daemon)]);
        run(process.execPath, [
            "--conditions=plurnk-dev",
            resolve(root, "plurnk-core", "bin", "digest.ts"),
            dbPath,
            resolve(stateDir, "digest"),
        ], root);
        process.stderr.write(`candidate artifact: ${stateDir}\n`);
    })();
    return finalizing;
};
const stopFromSignal = (status) => {
    void finalize().then(() => process.exit(status), (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
    });
};
process.once("SIGINT", () => stopFromSignal(130));
process.once("SIGTERM", () => stopFromSignal(143));

const address = await new Promise((accept, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("daemon did not publish its AG-UI address within 30 seconds")), 30_000);
    daemon.once("exit", (code) => reject(new Error(`daemon exited before startup (status ${code})`)));
    daemon.stdout.setEncoding("utf8");
    daemon.stdout.on("data", (chunk) => {
        process.stderr.write(chunk);
        output += chunk;
        const match = output.match(/agui=http:\/\/([^:]+):(\d+)/);
        if (match === null) return;
        clearTimeout(timeout);
        accept({ host: match[1], port: match[2] });
    });
});

client = spawn(
    process.execPath,
    [resolve(clientRoot, "bin", "plurnk.js"), ...process.argv.slice(2)],
    {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PLURNK_HOST: address.host,
            PLURNK_PORT: address.port,
        },
        stdio: "inherit",
    },
);

const status = await new Promise((accept, reject) => {
    client.once("error", reject);
    client.once("exit", (code, signal) => {
        if (signal !== null) reject(new Error(`client terminated by ${signal}`));
        else accept(code ?? 1);
    });
});

await finalize();
process.exit(status);
