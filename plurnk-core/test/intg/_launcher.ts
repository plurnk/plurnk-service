// Spawns the real launcher (src/service.ts) in a hermetic home and reports what happened:
// either the daemon banner arrived (and the database pool was observed from outside) or the
// process exited first, with its code and stderr. Shared by the launcher witnesses.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

export type Launch = { code: number | null; stderr: string; dbConnections: number | null };
export type LaunchPaths = { dir: string; dbPath: string };

export const launch = (
    overrides: Readonly<Record<string, string>>,
    prepare?: (paths: LaunchPaths) => Promise<void>,
): Promise<Launch> => new Promise((resolvePromise, rejectPromise) => {
    void (async () => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-launcher-"));
        const dbPath = join(dir, "plurnk.db");
        await prepare?.({ dir, dbPath });
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
        };
        delete env.PLURNK_MODEL;
        delete env.PLURNK_SERVICE_SQLITE_READERS;
        Object.assign(env, overrides);
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let counted = false;
        let dbConnections: number | null = null;
        const finish = async (result: Launch | Error): Promise<void> => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            if (result instanceof Error) rejectPromise(result); else resolvePromise(result);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            void finish(new Error(`launch timeout after 90s. stdout=${stdout} stderr=${stderr}`));
        }, 90_000);
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            if (counted || !/plurnk-service agui=http:\/\//.test(stdout)) return;
            counted = true;
            void (async () => {
                const fds = await readdir(`/proc/${child.pid}/fd`);
                const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${child.pid}/fd/${fd}`).catch(() => "")));
                dbConnections = targets.filter((target) => target === dbPath).length;
                child.kill("SIGTERM");
            })().catch((error: unknown) => { child.kill("SIGKILL"); void finish(error as Error); });
        });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => { void finish({ code, stderr, dbConnections }); });
        child.once("error", (error) => { void finish(error); });
    })().catch(rejectPromise);
});
