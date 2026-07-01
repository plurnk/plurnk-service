import test from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Git from "./Git.ts";
import type { ExecArgs, ExecResult } from "@plurnk/plurnk-execs";

const present = (bin: string): boolean => spawnSync("sh", ["-c", `command -v "$1"`, "sh", bin]).status === 0;
const make = (tag: string): Git => new Git({ runtime: tag, glyph: "•" });

const run = async (tag: string, command: string): Promise<{ result: ExecResult; out: Record<string, string> }> => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const args: ExecArgs = {
        runtime: tag, command, cwd: null, target: null,
        signal: new AbortController().signal,
        write: (c, chunk) => { out[c] = (out[c] ?? "") + chunk; },
        setState: () => {}, emit: () => {},
    };
    const result = await make(tag).run(args);
    return { result, out };
};

test("manifest declares git + gh", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["git", "gh"]);
});

test("channels: stdout + stderr; effect: host for both tags", () => {
    for (const tag of ["git", "gh"]) {
        const ex = make(tag);
        assert.deepEqual(ex.channels, { stdout: { mimetype: "text/stream" }, stderr: { mimetype: "text/stream" } });
        assert.equal(ex.effect(null), "host");
        assert.equal(ex.effect("/some/repo"), "host");
    }
});

test("spawnArgs: the tag is the binary; command tokenized into real argv (no shell)", () => {
    // @ts-expect-error exercise the protected hook
    assert.deepEqual(make("git").spawnArgs("git", 'commit -m "msg $X"'),
        { cmd: "git", args: ["commit", "-m", "msg $X"], useShell: false });
    // @ts-expect-error
    assert.deepEqual(make("gh").spawnArgs("gh", "pr list --state open"),
        { cmd: "gh", args: ["pr", "list", "--state", "open"], useShell: false });
});

test("probe: git reflects PATH presence", async () => {
    const r = await make("git").probe();
    assert.equal(r.available, present("git"));
});

test("probe: gh requires PATH + authentication", async () => {
    const r = await make("gh").probe();
    if (!present("gh")) { assert.equal(r.available, false); return; }
    // gh present: available iff `gh auth status` exits 0; detail explains either way.
    const authed = spawnSync("gh", ["auth", "status"]).status === 0;
    assert.equal(r.available, authed);
    if (!authed) assert.match(String(r.detail), /authenticat/i);
});

test("live: git --version runs through the executor", { skip: !present("git") }, async () => {
    const { result, out } = await run("git", "--version");
    assert.equal(result.status, 200);
    assert.match(out.stdout, /git version/);
});
