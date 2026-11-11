import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ExecScratch from "./ExecScratch.ts";

test("{§exec-target-routing}: an explicit absolute value names the directory", () => {
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "/srv/scratch/", XDG_RUNTIME_DIR: "/run/user/1000" }), "/srv/scratch");
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "~/scratch" }), join(homedir(), "scratch"));
});

test("{§exec-target-routing}: unset or empty derives $XDG_RUNTIME_DIR/plurnk", () => {
    assert.equal(ExecScratch.directory({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/plurnk");
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "", XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/plurnk");
});

test("{§exec-target-routing}: without XDG_RUNTIME_DIR the platform temporary directory applies", () => {
    assert.equal(ExecScratch.directory({}), tmpdir());
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "", XDG_RUNTIME_DIR: "" }), tmpdir());
});

test("{§exec-target-routing}: a relative value fails by name", () => {
    assert.throws(() => ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "scratch/here" }), {
        name: "ConfigurationError",
        key: "PLURNK_SERVICE_EXEC_SCRATCH",
        message: "PLURNK_SERVICE_EXEC_SCRATCH must be an absolute directory path.",
    });
    assert.throws(() => new ExecScratch({ PLURNK_SERVICE_EXEC_SCRATCH: "./scratch" }), /PLURNK_SERVICE_EXEC_SCRATCH/u);
});

test("{§exec-target-routing}: a source path is unique and keeps its extension under the directory", () => {
    const scratch = new ExecScratch({ PLURNK_SERVICE_EXEC_SCRATCH: join(tmpdir(), "plurnk-scratch-unit") });
    const first = scratch.path(".py");
    const second = scratch.path(".py");
    assert.notEqual(first, second);
    assert.match(first, /\/plurnk-scratch-unit\/plurnk-exec-[0-9a-f-]{36}\.py$/u);
});

test("{§exec-target-routing}: running as root with PLURNK_EXECS_SPAWN_USER grants 0710 traversal and 0600 script ownership to the spawn account", async (t) => {
    const base = await fs.mkdtemp(join(tmpdir(), "plurnk-scratch-root-"));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const nested = join(base, "outer", "inner");
    const chownCalls: Array<{ path: string; uid: number; gid: number }> = [];
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    t.mock.method(process, "geteuid", () => 0);
    t.mock.method(fs, "chown", async (path: Parameters<typeof fs.chown>[0], uid: number, gid: number) => {
        chownCalls.push({ path: String(path), uid, gid });
    });
    const realChmod = fs.chmod.bind(fs);
    t.mock.method(fs, "chmod", async (path: Parameters<typeof fs.chmod>[0], mode: Parameters<typeof fs.chmod>[1]) => {
        chmodCalls.push({ path: String(path), mode: Number(mode) });
        await realChmod(path, mode);
    });
    const scratch = new ExecScratch({
        PLURNK_SERVICE_EXEC_SCRATCH: nested,
        PLURNK_EXECS_SPAWN_USER: "60007:60008",
    });
    assert.equal(await scratch.unavailable(), null);
    assert.deepEqual(chownCalls, [
        { path: join(base, "outer"), uid: 0, gid: 60008 },
        { path: nested, uid: 0, gid: 60008 },
    ]);
    assert.deepEqual(chmodCalls, [
        { path: join(base, "outer"), mode: 0o710 },
        { path: nested, mode: 0o710 },
    ]);
    const staged = await scratch.stage(".py", "print(42)\n");
    assert.equal(await fs.readFile(staged, "utf8"), "print(42)\n");
    assert.equal((await fs.stat(staged)).mode & 0o777, 0o600);
    assert.deepEqual(chownCalls.at(-1), { path: staged, uid: 60007, gid: 60008 });
});
