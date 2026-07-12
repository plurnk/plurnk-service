// CLI contract tests — spawn bin/gbnf.ts and assert the §cli_* promises in SPEC.md.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "bin", "gbnf.ts");
const ECHO = join(here, "..", "e2e", "fixtures", "echo.gbnf");

type Run = { code: number; stdout: string; stderr: string };

const run = (args: string[], input = ""): Run => {
    try {
        const stdout = execFileSync("node", [CLI, ...args], { input, encoding: "utf8" });
        return { code: 0, stdout, stderr: "" };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
};

test("[§cli_json] prints the verdict as pretty JSON on stdout", () => {
    const { stdout } = run([ECHO], "<<ECHO:hi:ECHO");
    assert.deepEqual(JSON.parse(stdout), { status: "accept" });
    assert.match(stdout, /\n {2}"status"/); // 2-space indent
});

test("[§cli_exit] exit 0 on accept, 1 on reject/incomplete", () => {
    assert.equal(run([ECHO], "<<ECHO:hi:ECHO").code, 0);
    assert.equal(run([ECHO], "oops").code, 1);
    assert.equal(run([ECHO], "<<ECHO:hi").code, 1); // incomplete
});

test("[§cli_stdin] reads input from stdin when no input-file is given", () => {
    const { code, stdout } = run([ECHO], "<<ECHO::ECHO");
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).status, "accept");
});

test("[§cli_root] --root selects the start rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "gbnf-cli-"));
    try {
        const g = join(dir, "g.gbnf");
        writeFileSync(g, 'start ::= "x"\n');
        assert.equal(run([g, "--root", "start"], "x").code, 0);
        assert.equal(run([g], "x").code, 78); // default root missing → invalid grammar
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("[§cli_usage] a missing grammar argument is a usage error (exit 64)", () => {
    const { code, stderr } = run([]);
    assert.equal(code, 64);
    assert.match(stderr, /usage: gbnf/);
});
