// {§operator-config-precedence} — exercise the actual launcher, not a proxy parser.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

interface Fixture {
    root: string;
    home: string;
    configHome: string;
    dataHome: string;
    cwd: string;
    homeEnv: string;
    cwdEnv: string;
}

const fixture = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-env-cascade-"));
    const home = join(root, "home");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    const cwd = join(root, "work");
    const serviceHome = join(configHome, "plurnk");
    await mkdir(cwd);
    return {
        root,
        home,
        configHome,
        dataHome,
        cwd,
        homeEnv: join(serviceHome, ".env"),
        cwdEnv: join(cwd, ".env"),
    };
};

const runService = (
    fx: Fixture,
    args: readonly string[],
    opts: { env?: Readonly<Record<string, string>>; nodeArgs?: readonly string[] } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise, rejectPromise) => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fx.home,
        XDG_CONFIG_HOME: fx.configHome,
        XDG_DATA_HOME: fx.dataHome,
    };
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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `PLURNK_SERVICE_DB_PATH=${dbPath}\n`, "utf8");
};

const migratedPath = (result: { code: number | null; stdout: string; stderr: string }): string => {
    assert.equal(result.code, 0, `migration must succeed: ${result.stderr}`);
    const match = /^migrated: (.+)$/mu.exec(result.stdout);
    assert.ok(match !== null, `migration output must name its DB: ${result.stdout}`);
    return match[1];
};

test("launcher cascade: project config beats XDG user config; the derived DB uses XDG data", async () => {
    const fx = await fixture();
    try {
        const homeDb = join(fx.root, "home.db");
        const cwdDb = join(fx.root, "cwd.db");
        await envFile(fx.homeEnv, homeDb);
        await envFile(fx.cwdEnv, cwdDb);

        assert.equal(migratedPath(await runService(fx, ["migrate"])), cwdDb);
        await rm(fx.cwdEnv);
        assert.equal(migratedPath(await runService(fx, ["migrate"])), homeDb);
        await rm(fx.homeEnv);
        assert.equal(
            migratedPath(await runService(fx, ["migrate"])),
            join(fx.dataHome, "plurnk", "plurnk.db"),
            "an empty package floor derives the semantic XDG data path",
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

test("config discovery is provider-free, on-demand, and does not create a second config artifact", async () => {
    const fx = await fixture();
    try {
        const defaults = await runService(fx, ["config", "defaults"]);
        assert.equal(defaults.code, 0, defaults.stderr);
        assert.match(defaults.stdout, /Generated on demand/);
        assert.match(defaults.stdout, /═══ @plurnk\/plurnk-service ═══/);
        await assert.rejects(
            () => stat(join(fx.configHome, "plurnk")),
            /ENOENT/,
            "introspection does not bootstrap or persist an aggregate",
        );

        const check = await runService(fx, ["config", "check"]);
        assert.equal(check.code, 0, check.stderr);
        assert.match(check.stdout, /configuration valid/);
        assert.match(check.stdout, /provider requests: none/);

        const invalid = await runService(fx, ["config", "check"], {
            env: { PLURNK_MODEL: "missing" },
        });
        assert.equal(invalid.code, 1);
        assert.match(invalid.stderr, /PLURNK_MODEL=missing names no declared alias/);
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("config edit preserves editor arguments and an XDG path containing spaces", async () => {
    const fx = await fixture();
    try {
        const configHome = join(fx.root, "config home");
        const editor = join(fx.root, "editor.mjs");
        const marker = join(fx.root, "edited-path.txt");
        await writeFile(editor, [
            'import { writeFileSync } from "node:fs";',
            'writeFileSync(process.env.PLURNK_EDITOR_MARKER, process.argv[2] ?? "missing");',
        ].join("\n"));

        const edited = await runService(fx, ["config", "edit"], {
            env: {
                XDG_CONFIG_HOME: configHome,
                VISUAL: `${process.execPath} ${editor}`,
                PLURNK_EDITOR_MARKER: marker,
            },
        });
        assert.equal(edited.code, 0, edited.stderr);
        assert.equal(await readFile(marker, "utf8"), join(configHome, "plurnk", ".env"));
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("legacy mixed state blocks ordinary startup until the explicit one-way path migration", async () => {
    const fx = await fixture();
    try {
        const legacy = join(fx.home, ".plurnk");
        await mkdir(legacy, { recursive: true });
        await writeFile(join(legacy, ".env"), "PLURNK_MODEL=legacy\n");
        await writeFile(join(legacy, "plurnk.db"), "fixture");

        const refused = await runService(fx, ["migrate"]);
        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /run plurnk-service paths migrate/);

        const transitioned = await runService(fx, ["paths", "migrate"]);
        assert.equal(transitioned.code, 0, transitioned.stderr);
        assert.match(transitioned.stdout, /paths migrated:[\s\S]*\.plurnk\/\.env -> .*\/plurnk\/\.env/);
        assert.equal(
            await readFile(join(fx.configHome, "plurnk", ".env"), "utf8"),
            "PLURNK_MODEL=legacy\n",
        );
        assert.equal(
            await readFile(join(fx.dataHome, "plurnk", "plurnk.db"), "utf8"),
            "fixture",
        );
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});
