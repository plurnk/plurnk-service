import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import SkillDirectory from "./SkillDirectory.ts";
import { parseSkill } from "./SkillDocument.ts";

const exec = promisify(execFile);
const source = "---\r\nname: sample\r\ndescription: Inspect a sample\r\nlicense: MIT\r\ncompatibility: Node.js\r\nmetadata:\r\n  author: example\r\n---\r\n\r\nRead [the guide](references/guide.md).\r\nRun `scripts/check.mjs`.\r\n";

test("{§agent-skills-directory} preserves the complete source and optional metadata", () => {
    const doc = parseSkill("/skills/sample/SKILL.md", "sample", source);
    assert.equal(doc.source, source);
    assert.equal(doc.name, "sample");
    assert.equal(doc.description, "Inspect a sample");
    assert.equal(doc.metadata.license, "MIT");
    assert.equal(doc.metadata.compatibility, "Node.js");
    assert.deepEqual(doc.metadata.metadata, { author: "example" });
    assert.equal(doc.body, "\r\nRead [the guide](references/guide.md).\r\nRun `scripts/check.mjs`.\r\n");
    const alias = parseSkill("/skills/sample/SKILL.md", "sample", "---\nname: sample\ndescription: &summary Inspect a sample\nmetadata:\n  summary: *summary\n---\nInstructions.\n");
    assert.deepEqual(alias.metadata.metadata, { summary: "Inspect a sample" }, "ordinary YAML aliases use the parser's bounded standard behavior");
});

test("{§agent-skills-directory} validates the standard discovery fields", () => {
    const parse = (raw: string) => parseSkill("/x/sample/SKILL.md", "sample", raw);
    assert.throws(() => parse("# no frontmatter"), /requires YAML frontmatter/);
    assert.throws(() => parse("---\nname: sample\n"), /frontmatter is not closed/);
    assert.throws(() => parse("---\nname: sample\ndescription: [\n---\n"), /invalid YAML/);
    assert.throws(() => parse("---\n- a\n---\n"), /must be a mapping/);
    assert.throws(() => parse("---\ndescription: x\n---\n"), /requires name/);
    assert.throws(() => parse("---\nname: Sample\ndescription: x\n---\n"), /name "Sample" is invalid/);
    assert.throws(() => parse("---\nname: other\ndescription: x\n---\n"), /must match folder "sample"/);
    assert.throws(() => parse("---\nname: sample\n---\n"), /requires description/);
    assert.throws(() => parse(`---\nname: sample\ndescription: ${"x".repeat(1025)}\n---\n`), /description exceeds 1024/);
});

test("{§agent-skills-disclosure} reads nested resources, scripts and binary assets from a live source tree", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-directory-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "sample");
    for (const subdir of ["references/nested", "scripts", "assets"]) {
        await mkdir(join(dir, subdir), { recursive: true });
    }
    await writeFile(join(dir, "SKILL.md"), source);
    await writeFile(join(dir, "references/guide.md"), "See nested/rules.md.");
    await writeFile(join(dir, "references/nested/rules.md"), "Keep the original tree.");
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a]);
    await writeFile(join(dir, "assets/example.bin"), bytes);
    await writeFile(join(dir, "scripts/value.mjs"), "export default 'bundled dependency';");
    await writeFile(join(dir, "scripts/check.mjs"), "import value from './value.mjs';\nconsole.log(value);\n");

    const skill = await SkillDirectory.load(dir);
    assert.equal(skill.directory, dir);
    assert.equal(skill.document.source, source);
    assert.deepEqual(await skill.list(), [
        "SKILL.md", "assets/example.bin", "references/guide.md", "references/nested/rules.md", "scripts/check.mjs", "scripts/value.mjs",
    ]);
    assert.equal((await skill.read("references/nested/rules.md")).toString(), "Keep the original tree.");
    assert.deepEqual(await skill.read("assets/example.bin"), bytes);
    const { stdout } = await exec(process.execPath, [await skill.resolve("scripts/check.mjs")], { cwd: skill.directory });
    assert.equal(stdout, "bundled dependency\n");

    await writeFile(join(dir, "references/nested/rules.md"), "Changed without editing SKILL.md.");
    assert.equal((await skill.read("references/nested/rules.md")).toString(), "Changed without editing SKILL.md.");
    await rm(join(dir, "references/guide.md"));
    assert.ok(!(await skill.list()).includes("references/guide.md"));
    await assert.rejects(() => skill.read("references/guide.md"), { code: "ENOENT" });
    assert.equal(await readFile(join(dir, "SKILL.md"), "utf8"), source);
});

test("{§agent-skills-directory} follows installer links while bounding supporting links to the skill root", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "package-source");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), source);
    await writeFile(join(dir, "guide.md"), "Inside.");
    await symlink(dir, join(root, "sample"));
    await symlink("guide.md", join(dir, "alias.md"));
    const skill = await SkillDirectory.load(join(root, "sample"));
    assert.equal(skill.directory, dir);
    assert.equal((await skill.read("alias.md")).toString(), "Inside.");
    await writeFile(join(root, "outside.md"), "Outside.");
    await symlink("../outside.md", join(dir, "outside.md"));
    await assert.rejects(() => skill.read("../outside.md"), { code: "SKILL_PATH_OUTSIDE_ROOT" });
    await assert.rejects(() => skill.read(join(root, "outside.md")), { code: "SKILL_PATH_OUTSIDE_ROOT" });
    await assert.rejects(() => skill.read("outside.md"), { code: "SKILL_PATH_OUTSIDE_ROOT" });
    await assert.rejects(() => skill.read("missing.md"), { code: "ENOENT" });
    await assert.rejects(() => skill.read("."), { code: "SKILL_RESOURCE_NOT_FILE" });
    await rm(join(dir, "outside.md"));
    await symlink(".", join(dir, "cycle"));
    await assert.rejects(() => skill.list(), { code: "SKILL_DIRECTORY_CYCLE" });
});
