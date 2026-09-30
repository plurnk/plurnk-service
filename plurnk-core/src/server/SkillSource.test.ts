// {§skills-sources} Source forms, skill finding and installation containment, on the filesystem alone;
// git and archive fetches are witnessed in test/intg/Skills.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SkillSource from "./SkillSource.ts";

const skill = (name: string, description = `Use ${name}.`): string => `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

const problemType = (code: string) => (error: { problem?: { type?: string } }): boolean =>
    error.problem?.type === `https://problems.plurnk.xyz/skills/functionality/${code}`;

const fixture = async (t: test.TestContext): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-skill-source-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    return base;
};

test("{§skills-sources} a git remote is a full https or ssh URL; other schemes and owner/repo shorthand are refused", async () => {
    const context = { projectRoot: null, home: "/home/ada" };
    for (const remote of ["https://forge.example/acme/skills.git", "ssh://git@forge.example/acme/skills.git", "git@forge.example:acme/skills.git"]) {
        assert.deepEqual(await SkillSource.locate(remote, context), { kind: "git", location: remote });
    }
    for (const refused of ["http://forge.example/acme/skills.git", "git://forge.example/acme/skills.git", "file:///srv/skills.git"]) {
        await assert.rejects(() => SkillSource.locate(refused, context), problemType("source-invalid"), refused);
    }
    await assert.rejects(() => SkillSource.locate("https://token@forge.example/acme/skills.git", context),
        (error: { problem?: { type?: string; detail?: string; source?: string } }) =>
            problemType("source-invalid")(error) && error.problem!.source === undefined && !error.problem!.detail!.includes("token"),
        "a credential in a source URL is refused without being echoed");
    await assert.rejects(() => SkillSource.locate("acme/skills", { projectRoot: "/nowhere", home: "/home/ada" }),
        (error: { problem?: { type?: string; detail?: string } }) => problemType("source-missing")(error) && /shorthand names no forge/u.test(error.problem!.detail!));
    await assert.rejects(() => SkillSource.locate("skills", context), problemType("source-invalid"), "a relative source needs a project root");
});

test("{§skills-sources} a local source is a folder, a SKILL.md, or a zip or tar archive; a relative one is the project's", async (t) => {
    const base = await fixture(t);
    await mkdir(join(base, "kit"));
    await writeFile(join(base, "kit", "SKILL.md"), skill("kit"));
    for (const archive of ["kit.zip", "kit.tar", "kit.tgz", "kit.tar.gz", "kit.tar.xz"]) await writeFile(join(base, archive), "");
    await writeFile(join(base, "notes.txt"), "");
    const context = { projectRoot: base, home: join(base, "home") };
    assert.deepEqual(await SkillSource.locate("kit", context), { kind: "folder", location: join(base, "kit") });
    assert.deepEqual(await SkillSource.locate(join(base, "kit", "SKILL.md"), context), { kind: "skill-file", location: join(base, "kit", "SKILL.md") });
    for (const archive of ["kit.zip", "kit.tar", "kit.tgz", "kit.tar.gz", "kit.tar.xz"]) {
        assert.deepEqual(await SkillSource.locate(archive, context), { kind: "archive", location: join(base, archive) });
    }
    await assert.rejects(() => SkillSource.locate("notes.txt", context), problemType("source-invalid"));
    await mkdir(join(base, "home", "mine"), { recursive: true });
    assert.deepEqual(await SkillSource.locate("~/mine", { projectRoot: null, home: join(base, "home") }), { kind: "folder", location: join(base, "home", "mine") });
});

test("{§skills-sources} local skills retain their standard folder identity; nested examples and .git are not skills", async (t) => {
    const base = await fixture(t);
    const source = join(base, "root-skill");
    await mkdir(join(source, "skills", "alpha", "examples", "inner"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), skill("root-skill"));
    const opened = await SkillSource.open({ kind: "folder", location: source });
    t.after(() => opened.close());
    assert.deepEqual(opened.skills.map(({ name, dir }) => ({ name, dir })), [{ name: "root-skill", dir: source }],
        "a skill at the root is the source; nothing below it is walked");
    const misnamed = join(base, "checkout-dir");
    await mkdir(misnamed);
    await writeFile(join(misnamed, "SKILL.md"), skill("root-skill"));
    const rejected = await SkillSource.open({ kind: "skill-file", location: join(misnamed, "SKILL.md") });
    assert.deepEqual(rejected.skills, [], "a SKILL.md is read in its actual directory, not renamed in a temporary copy");
    assert.match(rejected.invalid[0]!.reason, /must match folder "checkout-dir"/u);
    await rejected.close();

    const tree = join(base, "tree");
    await mkdir(join(tree, "skills", "alpha", "examples", "inner"), { recursive: true });
    await mkdir(join(tree, "skills", "misnamed"), { recursive: true });
    await mkdir(join(tree, ".git", "hidden"), { recursive: true });
    await writeFile(join(tree, "skills", "alpha", "SKILL.md"), skill("alpha", "Alpha."));
    await writeFile(join(tree, "skills", "alpha", "examples", "inner", "SKILL.md"), skill("inner"));
    await writeFile(join(tree, "skills", "misnamed", "SKILL.md"), skill("other"));
    await writeFile(join(tree, ".git", "hidden", "SKILL.md"), skill("hidden"));
    const walked = await SkillSource.open({ kind: "folder", location: tree });
    t.after(() => walked.close());
    assert.deepEqual(walked.skills.map(({ name, description, dir }) => ({ name, description, dir })), [
        { name: "alpha", description: "Alpha.", dir: join(tree, "skills", "alpha") },
    ], "a skill's own examples are not skills, and .git is never read");
    assert.deepEqual(walked.invalid.map(({ dir }) => dir), [join(tree, "skills", "misnamed")]);
    assert.match(walked.invalid[0]!.reason, /must match folder "misnamed"/u);
});

test("{§skills-sources} an Agent Plugin source is refused: its skills keep the plugin's identity", async (t) => {
    const base = await fixture(t);
    await mkdir(join(base, "plugin", "skills", "alpha"), { recursive: true });
    await writeFile(join(base, "plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    await writeFile(join(base, "plugin", "skills", "alpha", "SKILL.md"), skill("alpha"));
    await assert.rejects(() => SkillSource.open({ kind: "folder", location: join(base, "plugin") }), problemType("source-is-plugin"));
});

test("{§skills-sources} install places a skill under its name and refuses links out of it, leaving the root clean", async (t) => {
    const base = await fixture(t);
    const root = join(base, "root");
    const kept = join(base, "kept");
    await mkdir(join(kept, "docs"), { recursive: true });
    await writeFile(join(kept, "SKILL.md"), skill("kept"));
    await writeFile(join(kept, "docs", "guide.md"), "Guide.\n");
    await symlink("docs/guide.md", join(kept, "guide.md"));
    assert.equal(await SkillSource.install({ name: "kept", description: "Use kept.", dir: kept }, root), join(root, "kept"));
    assert.deepEqual((await readdir(join(root, "kept"))).toSorted(), ["SKILL.md", "docs", "guide.md"], "an inward link is kept");

    const leaky = join(base, "leaky");
    await mkdir(leaky);
    await writeFile(join(leaky, "SKILL.md"), skill("leaky"));
    await symlink("../../secrets", join(leaky, "secrets"));
    await assert.rejects(() => SkillSource.install({ name: "leaky", description: "Use leaky.", dir: leaky }, root), problemType("source-unsafe"));
    assert.deepEqual(await readdir(root), ["kept"], "a refused install leaves nothing behind");
});
