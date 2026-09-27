import assert from "node:assert/strict";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ExecScratch from "./ExecScratch.ts";

test("{§exec-scratch-directory}: an explicit absolute value names the directory", () => {
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "/srv/scratch/", XDG_RUNTIME_DIR: "/run/user/1000" }), "/srv/scratch");
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "~/scratch" }), join(homedir(), "scratch"));
});

test("{§exec-scratch-directory}: unset or empty derives $XDG_RUNTIME_DIR/plurnk", () => {
    assert.equal(ExecScratch.directory({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/plurnk");
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "", XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/plurnk");
});

test("{§exec-scratch-directory}: without XDG_RUNTIME_DIR the platform temporary directory applies", () => {
    assert.equal(ExecScratch.directory({}), tmpdir());
    assert.equal(ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "", XDG_RUNTIME_DIR: "" }), tmpdir());
});

test("{§exec-scratch-directory}: a relative value fails by name", () => {
    assert.throws(() => ExecScratch.directory({ PLURNK_SERVICE_EXEC_SCRATCH: "scratch/here" }), {
        name: "RangeError",
        message: "PLURNK_SERVICE_EXEC_SCRATCH must be an absolute directory path.",
    });
    assert.throws(() => new ExecScratch({ PLURNK_SERVICE_EXEC_SCRATCH: "./scratch" }), /PLURNK_SERVICE_EXEC_SCRATCH/u);
});

test("{§exec-scratch-directory}: a source path is unique and keeps its extension under the directory", () => {
    const scratch = new ExecScratch({ PLURNK_SERVICE_EXEC_SCRATCH: join(tmpdir(), "plurnk-scratch-unit") });
    const first = scratch.path(".py");
    const second = scratch.path(".py");
    assert.notEqual(first, second);
    assert.match(first, /\/plurnk-scratch-unit\/plurnk-exec-[0-9a-f-]{36}\.py$/u);
});
