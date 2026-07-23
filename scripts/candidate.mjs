import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const clientRoot = resolve(process.env.PLURNK_CLIENT_CHECKOUT ?? resolve(root, "..", "repo", "plurnk"));
const stateDir = mkdtempSync(resolve(tmpdir(), "plurnk-candidate-"));
const dbPath = resolve(stateDir, "plurnk.db");

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
const cleanup = () => {
    if (client !== undefined && client.exitCode === null) client.kill("SIGTERM");
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
process.once("exit", cleanup);

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

cleanup();
process.exit(status);
