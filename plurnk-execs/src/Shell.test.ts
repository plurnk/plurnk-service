import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import Shell from "./Shell.ts";

const shellFixture = async (t: test.TestContext): Promise<{ dir: string; shell: (name: string, script: string, mode?: number) => Promise<string> }> => {
    const dir = await mkdtemp(join(tmpdir(), "execs-shell-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return {
        dir,
        shell: async (name, script, mode = 0o755) => {
            const file = join(dir, name);
            await writeFile(file, `#!/bin/sh\n${script}\n`, { mode });
            return file;
        },
    };
};

test("{§executor-subprocess}: an executable $SHELL is the shell, named with the version it reports", async (t) => {
    const { shell } = await shellFixture(t);
    const declared = await shell("fakesh", 'printf "fakesh, version 4.2.1(1)-release (x86_64)\\n"');
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "fakesh", version: "4.2.1" });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with fakesh 4.2.1 (${declared}).`);
});

test("{§executor-subprocess}: a shell that reports no version is named without one", async (t) => {
    const { shell } = await shellFixture(t);
    const declared = await shell("quietsh", "exit 2");
    const choice = Shell.resolve({ SHELL: declared });
    assert.deepEqual(choice, { path: declared, program: "quietsh", version: null });
    assert.equal(Shell.summary(choice), `Run shell commands and scripts with quietsh (${declared}).`);
});

test("{§executor-subprocess}: a $SHELL that names no executable file leaves the system shell", async (t) => {
    const { dir, shell } = await shellFixture(t);
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
        ["unset", {}],
        ["empty", { SHELL: "" }],
        ["relative", { SHELL: "bash" }],
        ["missing", { SHELL: join(dir, "absent") }],
        ["a directory", { SHELL: dir }],
        ["not executable", { SHELL: await shell("plainsh", "exit 0", 0o644) }],
    ];
    for (const [label, env] of cases) {
        assert.equal(Shell.resolve(env).path, Shell.SYSTEM, `${label} $SHELL runs ${Shell.SYSTEM}`);
    }
    assert.equal(Shell.current(), Shell.current());
    assert.ok(isAbsolute(Shell.current().path), "the shell is spawned by its path");
});
