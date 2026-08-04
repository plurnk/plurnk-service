// {§operator-config-precedence} — exercise the actual launcher, not a proxy parser.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

interface Fixture {
    root: string;
    home: string;
    cwd: string;
    homeEnv: string;
    cwdEnv: string;
    catalog: string;
}

const fixture = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-env-cascade-"));
    const home = join(root, "home");
    const cwd = join(root, "work");
    const serviceHome = join(home, ".plurnk");
    await mkdir(serviceHome, { recursive: true });
    await mkdir(cwd);
    return {
        root,
        home,
        cwd,
        homeEnv: join(serviceHome, ".env"),
        cwdEnv: join(cwd, ".env"),
        catalog: join(serviceHome, ".env.defaults"),
    };
};

const runService = (
    fx: Fixture,
    args: readonly string[],
    opts: { env?: Readonly<Record<string, string>>; nodeArgs?: readonly string[] } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise, rejectPromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.home };
    delete env.PLURNK_SERVICE_DB_PATH;
    delete env.PLURNK_DB_PATH;
    delete env.PLURNK_MODEL;
    Object.assign(env, opts.env);
    const child = spawn(
        process.execPath,
        [...(opts.nodeArgs ?? []), ...CONDITION_ARGS, BIN_PATH, ...args],
        { cwd: fx.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`launcher timeout: stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
    });
    child.once("exit", (code) => {
        clearTimeout(timeout);
        resolvePromise({ code, stdout, stderr });
    });
});

const envFile = async (path: string, dbPath: string): Promise<void> => {
    await writeFile(path, `PLURNK_SERVICE_DB_PATH=${dbPath}\n`, "utf8");
};

const migratedPath = (result: { code: number | null; stdout: string; stderr: string }): string => {
    assert.equal(result.code, 0, `migration must succeed: ${result.stderr}`);
    const match = /^migrated: (.+)$/mu.exec(result.stdout);
    assert.ok(match !== null, `migration output must name its DB: ${result.stdout}`);
    return match[1];
};

test("launcher cascade: cwd beats home, while the generated catalog is output-only", async () => {
    const fx = await fixture();
    try {
        const homeDb = join(fx.root, "home.db");
        const cwdDb = join(fx.root, "cwd.db");
        const catalogDb = join(fx.root, "catalog-must-not-load.db");
        await envFile(fx.homeEnv, homeDb);
        await envFile(fx.cwdEnv, cwdDb);
        await envFile(fx.catalog, catalogDb);

        assert.equal(migratedPath(await runService(fx, ["migrate"])), cwdDb);
        await rm(fx.cwdEnv);
        assert.equal(migratedPath(await runService(fx, ["migrate"])), homeDb);
        await rm(fx.homeEnv);
        await envFile(fx.catalog, catalogDb);
        assert.equal(
            migratedPath(await runService(fx, ["migrate"])),
            join(fx.home, ".plurnk", "plurnk.db"),
            "the regenerated catalog is never read as a configuration layer",
        );
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("launcher cascade: config, env files, shell, and CLI retain their tiers", async () => {
    const fx = await fixture();
    try {
        const first = join(fx.root, "first.env");
        const second = join(fx.root, "second.env");
        const firstDb = join(fx.root, "first.db");
        const secondDb = join(fx.root, "second.db");
        const shellDb = join(fx.root, "shell.db");
        const cliDb = join(fx.root, "cli.db");
        await envFile(first, firstDb);
        await envFile(second, secondDb);

        assert.equal(
            migratedPath(await runService(fx, ["--config", first, "migrate"])),
            firstDb,
            "the service-owned config layer supplies an otherwise-unset value",
        );
        assert.equal(
            migratedPath(await runService(fx, ["--config", first, `--env-file=${second}`, "migrate"])),
            secondDb,
            "the env-file layer outranks the lower config layer",
        );
        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${second}`, `--config=${first}`, "migrate"])),
            secondDb,
            "argv interleaving does not turn config into a second native env-file path",
        );
        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${first}`, `--env-file=${second}`, "migrate"])),
            secondDb,
            "later env files override earlier env files",
        );
        assert.equal(
            migratedPath(await runService(fx, ["migrate"], { nodeArgs: [`--env-file=${first}`, `--env-file=${second}`] })),
            secondDb,
            "native env-file placement before the script retains the same ordering",
        );
        assert.equal(
            migratedPath(await runService(
                fx,
                [`--env-file=${first}`, `--env-file=${second}`, "migrate"],
                { env: { PLURNK_SERVICE_DB_PATH: shellDb } },
            )),
            shellDb,
            "the initial shell overrides the complete explicit-file tier",
        );
        assert.equal(
            migratedPath(await runService(
                fx,
                [`--env-file=${first}`, `--service-db-path=${cliDb}`, "migrate"],
                { env: { PLURNK_SERVICE_DB_PATH: shellDb } },
            )),
            cliDb,
            "a derived service CLI flag overrides the shell",
        );
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("launcher cascade: env-file optional absence and required absence remain distinct from config", async () => {
    const fx = await fixture();
    try {
        const selected = join(fx.root, "selected.env");
        const selectedDb = join(fx.root, "selected.db");
        const missing = join(fx.root, "missing.env");
        await envFile(selected, selectedDb);

        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${selected}`, `--env-file-if-exists=${missing}`, "migrate"])),
            selectedDb,
        );
        const required = await runService(fx, [`--env-file=${missing}`, "migrate"]);
        assert.notEqual(required.code, 0, required.stderr);
        assert.match(required.stderr, /missing\.env.*not found/);

        const config = await runService(fx, ["--config", missing, "migrate"]);
        assert.equal(config.code, 64, config.stderr);
        assert.match(config.stderr, /missing\.env.*does not exist/);
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});
