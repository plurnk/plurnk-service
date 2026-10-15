import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Shell from "./Shell.ts";

// {§executor-shell} — every way `$SHELL` can stand, and what `sh` runs for each.
const fixture = async (t: test.TestContext): Promise<{ dir: string; shell: (name: string, script: string, mode?: number) => Promise<string> }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-shell-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return {
        dir,
        shell: async (name, script, mode = 0o755) => {
            const file = path.join(dir, name);
            await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode });
            return file;
        },
    };
};

test("{§executor-shell}: an executable $SHELL is the shell, named with the version it reports", async (t) => {
    const { shell } = await fixture(t);
    const declared = await shell("fakesh", 'printf "fakesh, version 4.2.1(1)-release (x86_64)\\n"');
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "fakesh", version: "4.2.1" });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with fakesh 4.2.1 (${declared}).`);
});

test("{§executor-shell}: a shell that reports no version is named without one", async (t) => {
    const { shell } = await fixture(t);
    const declared = await shell("quietsh", "exit 2");
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "quietsh", version: null });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with quietsh (${declared}).`);
});

test("{§executor-shell}: a $SHELL that names no executable file leaves the system shell", async (t) => {
    const { dir, shell } = await fixture(t);
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
        ["unset", {}],
        ["empty", { SHELL: "" }],
        ["relative", { SHELL: "bash" }],
        ["missing", { SHELL: path.join(dir, "absent") }],
        ["a directory", { SHELL: dir }],
        ["not executable", { SHELL: await shell("plainsh", "exit 0", 0o644) }],
    ];
    for (const [label, env] of cases) {
        assert.equal(Shell.resolve(env).path, Shell.SYSTEM, `${label} $SHELL runs ${Shell.SYSTEM}`);
    }
});

test("{§executor-shell}: one resolution per process serves every caller", () => {
    assert.equal(Shell.current(), Shell.current());
    assert.ok(path.isAbsolute(Shell.current().path), "the shell is spawned by its path");
});
