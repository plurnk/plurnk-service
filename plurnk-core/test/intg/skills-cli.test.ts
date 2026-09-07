import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("{§skills-functionality}: the standard-CLI fixture installs into a fresh XDG state home", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-cli-xdg-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    await mkdir(join(source, "alpha"), { recursive: true });
    await writeFile(join(source, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Test skill\n---\nUse alpha.\n");
    const home = join(root, "home");
    const state = join(root, "state");
    await promisify(execFile)(process.execPath, [join(import.meta.dirname, "_skills-cli.mjs"), "add", source, "--skill", "alpha", "--global"], {
        cwd: root,
        env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
    });
    assert.match(await readFile(join(home, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /name: alpha/);
    const lock = JSON.parse(await readFile(join(state, "skills", ".skill-lock.json"), "utf8"));
    assert.equal(lock.skills.alpha.source, source);
});
