import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HostPaths from "./HostPaths.ts";
import LegacyHome from "./LegacyHome.ts";

const fixture = async (): Promise<{ root: string; paths: HostPaths }> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-legacy-home-"));
    return {
        root,
        paths: new HostPaths({
            home: join(root, "home"),
            env: {
                XDG_CONFIG_HOME: join(root, "config"),
                XDG_DATA_HOME: join(root, "data"),
            },
        }),
    };
};

test("{§legacy-home-transition} ordinary use names the explicit recovery", async () => {
    const { root, paths } = await fixture();
    try {
        await mkdir(paths.legacyDir, { recursive: true });
        await assert.rejects(
            () => LegacyHome.assertCanonical(paths),
            /run plurnk-service paths migrate/,
        );
        await mkdir(paths.configDir, { recursive: true });
        await assert.rejects(
            () => LegacyHome.assertCanonical(paths),
            /legacy .* and canonical Plurnk paths both exist/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§legacy-home-transition} migration splits owned files, drops generated references, and is idempotent", async () => {
    const { root, paths } = await fixture();
    try {
        await mkdir(paths.legacyDir, { recursive: true });
        await writeFile(join(paths.legacyDir, ".env"), "PLURNK_MODEL=mine\n", { mode: 0o600 });
        await writeFile(join(paths.legacyDir, "AGENTS.md"), "# Mine\n");
        await writeFile(join(paths.legacyDir, "plurnk.db"), "sqlite fixture");
        await writeFile(join(paths.legacyDir, "plurnk.db-wal"), "wal fixture");
        await writeFile(join(paths.legacyDir, ".env.defaults"), "generated");
        await writeFile(join(paths.legacyDir, "INSTALL.md"), "generated");

        const moved = await LegacyHome.migrate(paths);
        assert.deepEqual(moved, [
            { source: join(paths.legacyDir, ".env"), destination: paths.configFile },
            { source: join(paths.legacyDir, "AGENTS.md"), destination: paths.policyFile },
            { source: join(paths.legacyDir, "plurnk.db"), destination: paths.databaseFile },
            { source: join(paths.legacyDir, "plurnk.db-wal"), destination: `${paths.databaseFile}-wal` },
        ]);
        assert.equal(await readFile(paths.configFile, "utf8"), "PLURNK_MODEL=mine\n");
        assert.equal(await readFile(paths.policyFile, "utf8"), "# Mine\n");
        assert.equal(await readFile(paths.databaseFile, "utf8"), "sqlite fixture");
        assert.equal((await stat(paths.configDir)).mode & 0o777, 0o700);
        assert.equal((await stat(paths.dataDir)).mode & 0o777, 0o700);
        await assert.rejects(() => stat(paths.legacyDir), /ENOENT/);
        assert.deepEqual(await LegacyHome.migrate(paths), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§legacy-home-transition} unknown members and destination conflicts are non-destructive", async () => {
    const { root, paths } = await fixture();
    try {
        await mkdir(paths.legacyDir, { recursive: true });
        await writeFile(join(paths.legacyDir, ".env"), "legacy");
        await writeFile(join(paths.legacyDir, "mystery"), "unknown");
        await assert.rejects(() => LegacyHome.migrate(paths), /unknown member\(s\): mystery/);
        assert.equal(await readFile(join(paths.legacyDir, ".env"), "utf8"), "legacy");

        await rm(join(paths.legacyDir, "mystery"));
        await mkdir(paths.configDir, { recursive: true });
        await assert.rejects(() => LegacyHome.migrate(paths), /destination\(s\) already exist/);
        assert.equal(await readFile(join(paths.legacyDir, ".env"), "utf8"), "legacy");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§legacy-home-transition} a partial destination failure rolls back created canonical state", async () => {
    const { root, paths } = await fixture();
    try {
        await mkdir(paths.legacyDir, { recursive: true });
        await writeFile(join(paths.legacyDir, ".env"), "legacy config");
        await writeFile(join(paths.legacyDir, "plurnk.db"), "legacy data");
        await writeFile(paths.dataHome, "blocks the data directory");

        await assert.rejects(() => LegacyHome.migrate(paths), /ENOTDIR/);
        assert.equal(await readFile(join(paths.legacyDir, ".env"), "utf8"), "legacy config");
        assert.equal(await readFile(join(paths.legacyDir, "plurnk.db"), "utf8"), "legacy data");
        await assert.rejects(() => stat(paths.configDir), /ENOENT/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§legacy-home-transition} a live database owner blocks migration", async () => {
    const { root, paths } = await fixture();
    try {
        await mkdir(paths.legacyDir, { recursive: true });
        await writeFile(join(paths.legacyDir, "plurnk.db"), "sqlite fixture");
        await writeFile(
            join(paths.legacyDir, "plurnk.db.lock"),
            `${JSON.stringify({ pid: process.pid, token: "live-fixture" })}\n`,
        );
        await assert.rejects(
            () => LegacyHome.migrate(paths),
            /database is already owned by daemon pid/,
        );
        assert.equal(await readFile(join(paths.legacyDir, "plurnk.db"), "utf8"), "sqlite fixture");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
