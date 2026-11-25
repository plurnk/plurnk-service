// {§skills-module} {§skills-sources} — workspace skill source allowlist, public-only git isolation,
// operator exemption without alias shadowing, and project-root symlink containment.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { SkillTree } from "@plurnk/plurnk-agent-skills";
import SkillsFunctionality, { publicOnly, skillsPolicy, workspaceSources } from "./Functionality.ts";
import Module from "./Module.ts";
import { SkillsActionError } from "./problems.ts";

const floor = {
    PLURNK_SKILLS_ENABLED: "1",
    PLURNK_SKILLS_FETCH_TIMEOUT_MS: "120000",
    PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp,git,local",
    PLURNK_SKILLS_PUBLIC_ONLY: "0",
};

const skillMd = (name: string, description = `Use ${name}.`): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

const rejectsProblem = async (run: () => Promise<unknown>, code: string, status: number): Promise<void> => {
    await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof SkillsActionError, `expected SkillsActionError, got ${String(error)}`);
        assert.equal(error.problem.type, `https://problems.plurnk.xyz/skills/functionality/${code}`);
        assert.equal(error.problem.status, status);
        return true;
    });
};

test("{§skills-module} workspaceSources, publicOnly, and skillsPolicy parse and validate confinement controls", () => {
    const shipped = parseEnv(readFileSync(new URL("../.env.defaults", import.meta.url), "utf8"));
    assert.deepEqual(skillsPolicy(shipped), {
        workspaceSources: ["mcp", "git", "local"],
        publicOnly: false,
    });
    assert.deepEqual(workspaceSources({ ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "" }), []);
    assert.deepEqual(workspaceSources({ ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp" }), ["mcp"]);
    assert.deepEqual(workspaceSources({ ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp, git, mcp" }), ["mcp", "git"]);
    assert.equal(publicOnly({ ...floor, PLURNK_SKILLS_PUBLIC_ONLY: "1" }), true);
    assert.equal(publicOnly({ ...floor, PLURNK_SKILLS_PUBLIC_ONLY: "0" }), false);

    assert.throws(
        () => workspaceSources({ ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "archive" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SKILLS_WORKSPACE_SOURCES",
    );
    assert.throws(
        () => publicOnly({ ...floor, PLURNK_SKILLS_PUBLIC_ONLY: "yes" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SKILLS_PUBLIC_ONLY",
    );
    assert.throws(
        () => SkillsFunctionality.validateConfiguration({ ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "bogus" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SKILLS_WORKSPACE_SOURCES",
    );
    assert.throws(
        () => SkillsFunctionality.validateConfiguration({ ...floor, PLURNK_SKILLS_PUBLIC_ONLY: "maybe" }),
        (error: unknown) => error instanceof ConfigurationError && error.key === "PLURNK_SKILLS_PUBLIC_ONLY",
    );
});

test("{§skills-module} {§skills-sources} PLURNK_SKILLS_WORKSPACE_SOURCES confines discover, admit, and prepare without local stat oracles while exempting exact operator and built-in skills", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-confinement-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateDir = join(root, "state");
    const operatorSkillDir = join(root, "ops-skill");
    const localSkillDir = join(root, "local-skill");
    const projectDir = join(root, "project");
    const outsideDir = join(root, "outside-tenant");
    await mkdir(operatorSkillDir, { recursive: true });
    await mkdir(localSkillDir, { recursive: true });
    await mkdir(join(projectDir, ".agents", "skills", "in-project"), { recursive: true });
    await mkdir(join(outsideDir, "stolen"), { recursive: true });
    await writeFile(join(operatorSkillDir, "SKILL.md"), skillMd("ops-skill", "Operator skill."));
    await writeFile(join(localSkillDir, "SKILL.md"), skillMd("local-skill", "Local skill."));
    await writeFile(join(projectDir, ".agents", "skills", "in-project", "SKILL.md"), skillMd("in-project", "Project skill."));
    await writeFile(join(outsideDir, "stolen", "SKILL.md"), skillMd("stolen", "Other tenant skill."));
    await symlink(join(outsideDir, "stolen"), join(projectDir, ".agents", "skills", "stolen"));

    const providedTree = {
        document: { name: "plurnk", description: "Built-in.", source: "provided:plurnk" },
    } as unknown as SkillTree;

    const env = {
        ...floor,
        PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp",
        PLURNK_SKILLS_ops_skill: JSON.stringify({ source: operatorSkillDir }),
    };

    const family = new SkillsFunctionality({
        workspacePaths: async () => ({
            home: root,
            projectRoot: projectDir,
            configurationRoots: [{ scope: "project", directory: join(projectDir, ".agents") }],
        }),
        readProvidedSkills: async () => new Map([["plurnk", providedTree]]),
        workspaceStateDirectory: async () => stateDir,
        operatorEnvironment: () => ({}),
        invokeModuleAction: async (name) => {
            assert.equal(name, "workspace.mcp.skills");
            return {
                found: true,
                skill: { name: "remote-skill", description: "From MCP.", commit: "a".repeat(64) },
                skills: [{ name: "remote-skill", description: "From MCP." }],
            };
        },
    }, { env });

    assert.deepEqual(family.policy(), { workspaceSources: ["mcp"], publicOnly: false });

    // available() lists built-in, in-project, and operator skills, while skipping the escaping project symlink.
    const available = await family.available({ workspaceId: 1 });
    assert.deepEqual(available.map(({ alias }) => alias).toSorted(), ["in-project", "ops-skill", "plurnk"]);

    // MCP discover and admit succeed under workspaceSources=mcp.
    const discovered = await family.discover({ source: "forge:///skills" }, { workspaceId: 1 });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.alias, "remote-skill");
    const admittedMcp = await family.admit({ alias: "remote-skill", source: "forge:///skills/remote-skill" }, { workspaceId: 1 });
    assert.equal(admittedMcp.definition.source, "forge:///skills/remote-skill");

    // Both existing and nonexistent local paths refuse identically with 403 (zero stat existence oracle).
    for (const blockedSource of [localSkillDir, "/nonexistent/secret-probe", "https://93.184.216.34/skills.git"]) {
        await rejectsProblem(() => family.discover({ source: blockedSource }, { workspaceId: 1 }), "skill-source-forbidden", 403);
        await rejectsProblem(() => family.admit({ alias: "local-skill", source: blockedSource }, { workspaceId: 1 }), "skill-source-forbidden", 403);
    }

    // Exact built-in, in-project, and operator skills prepare cleanly, while persisted non-operator local skill
    // AND a workspace override shadowing an operator alias with a DIFFERENT source are refused with 403!
    const prepared = await family.prepare({
        signal: new AbortController().signal,
        workspaceId: 1,
        enabled: new Map([
            ["plurnk", { definition: {} }],
            ["in-project", { definition: { source: join(projectDir, ".agents", "skills", "in-project") } }],
            ["ops-skill", { definition: { source: operatorSkillDir } }],
            ["persisted-local", { definition: { source: localSkillDir } }],
        ]),
        previous: null,
        failure: "publish-unavailable",
        admissions: [],
        progress: () => {},
        retain: () => () => {},
    });
    assert.equal(prepared.outcomes.get("plurnk")?.state, "active");
    assert.equal(prepared.outcomes.get("in-project")?.state, "active");
    assert.equal(prepared.outcomes.get("ops-skill")?.state, "active");
    const persistedOutcome = prepared.outcomes.get("persisted-local");
    assert.equal(persistedOutcome?.state, "unavailable");
    if (persistedOutcome?.state === "unavailable") {
        assert.equal(persistedOutcome.problem.status, 403);
        assert.equal(persistedOutcome.problem.type, "https://problems.plurnk.xyz/skills/functionality/skill-source-forbidden");
    }

    // Shadowing an operator alias with a different source does NOT inherit operator exemption.
    await rejectsProblem(
        () => family.prepare({
            signal: new AbortController().signal,
            workspaceId: 1,
            enabled: new Map([["ops-skill", { definition: { source: localSkillDir } }]]),
            previous: null,
            failure: "reject",
            admissions: [],
            progress: () => {},
            retain: () => () => {},
        }),
        "skill-source-forbidden",
        403,
    );

    // Empty allowlist blocks MCP as well.
    const emptyFamily = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots: [] }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => stateDir,
        operatorEnvironment: () => ({}),
    }, { env: { ...floor, PLURNK_SKILLS_WORKSPACE_SOURCES: "" } });
    await rejectsProblem(() => emptyFamily.discover({ source: "forge:///skills" }, { workspaceId: 1 }), "skill-source-forbidden", 403);
    await rejectsProblem(() => emptyFamily.admit({ alias: "a", source: "forge:///skills/a" }, { workspaceId: 1 }), "skill-source-forbidden", 403);
});

test("{§skills-module} {§skills-sources} PLURNK_SKILLS_PUBLIC_ONLY=1 enforces public https git URLs and credential-free git fetches while exempting exact operator git skills", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-public-git-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binDir = join(root, "bin");
    const logFile = join(root, "git-invocations.ndjson");
    await mkdir(binDir, { recursive: true });

    // Fake `git` records argv and env on every call and materializes a valid skill on clone.
    const fakeGit = join(binDir, "git");
    await writeFile(fakeGit, `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
    args,
    env: {
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? null,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? null,
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,
        GIT_ASKPASS: process.env.GIT_ASKPASS ?? null,
        GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL ?? null,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
        HOME: process.env.HOME ?? null,
    },
}) + "\\n");
if (args.includes("ls-remote")) {
    process.stdout.write("${"1".repeat(40)}\\tHEAD\\n");
} else if (args.includes("clone")) {
    const dest = args.at(-1);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\\nname: pub-skill\\ndescription: Public skill.\\n---\\nBody.\\n");
} else if (args.includes("rev-parse")) {
    process.stdout.write("${"1".repeat(40)}\\n");
}
`);
    await chmod(fakeGit, 0o700);

    const operatorGitUrl = "ssh://git@internal.corp/acme/skills.git";
    const env = {
        ...floor,
        PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp,git",
        PLURNK_SKILLS_PUBLIC_ONLY: "1",
        PLURNK_SKILLS_pub_skill: JSON.stringify({ source: operatorGitUrl }),
    };

    const family = new SkillsFunctionality({
        workspacePaths: async () => ({ home: root, projectRoot: null, configurationRoots: [] }),
        readProvidedSkills: async () => new Map(),
        workspaceStateDirectory: async () => join(root, "state"),
        operatorEnvironment: () => ({
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            HOME: "/home/operator",
            SSH_AUTH_SOCK: "/tmp/operator-ssh.sock",
            GITHUB_TOKEN: "ghp_operator_secret",
        }),
    }, { env });

    assert.deepEqual(family.policy(), { workspaceSources: ["mcp", "git"], publicOnly: true });

    // Private, loopback, IMDS, and SSH git sources are refused BEFORE spawning git.
    for (const blocked of [
        "ssh://git@93.184.216.34/org/skills.git",
        "git@93.184.216.34:org/skills.git",
        "https://localhost/org/skills.git",
        "https://127.0.0.1/org/skills.git",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/org/skills.git",
    ]) {
        await rejectsProblem(() => family.discover({ source: blocked }, { workspaceId: 1 }), "skill-url-forbidden", 403);
        await rejectsProblem(() => family.admit({ alias: "pub-skill", source: blocked }, { workspaceId: 1 }), "skill-url-forbidden", 403);
    }
    await assert.rejects(() => readFile(logFile, "utf8"), { code: "ENOENT" }, "refused git URLs must never spawn git");

    // Public https:// IP literal succeeds with isolated, credential-free, redirect-disabled git invocation.
    const admitted = await family.admit({ alias: "pub-skill", source: "https://93.184.216.34/org/skills.git" }, { workspaceId: 1 });
    assert.equal(admitted.definition.commit, "1".repeat(40));

    const discovered = await family.discover({ source: "https://93.184.216.34/org/skills.git" }, { workspaceId: 1 });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.alias, "pub-skill");

    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        args: string[];
        env: Record<string, string | null>;
    });
    assert.equal(lines.length, 3, "ls-remote + clone + rev-parse");
    for (const call of lines) {
        assert.equal(call.env.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null");
        assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
        assert.equal(call.env.GIT_ASKPASS, "/bin/false");
        assert.equal(call.env.GIT_ALLOW_PROTOCOL, "https");
        assert.equal(call.env.SSH_AUTH_SOCK, null);
        assert.equal(call.env.GITHUB_TOKEN, null);
        assert.equal(call.env.HOME, null);
    }
    assert.ok(lines[0].args.includes("http.followRedirects=false"));
    assert.ok(lines[0].args.includes("credential.helper="));
    assert.ok(lines[1].args.includes("http.followRedirects=false"));
    assert.ok(lines[1].args.includes("credential.helper="));

    // Exact operator SSH git definition remains exempt and still receives operator SSH/git env.
    await family.available({ workspaceId: 1 });
    const prepared = await family.prepare({
        signal: new AbortController().signal,
        workspaceId: 1,
        enabled: new Map([["pub-skill", { definition: { source: operatorGitUrl } }]]),
        previous: null,
        failure: "reject",
        admissions: [],
        progress: () => {},
        retain: () => () => {},
    });
    assert.equal(prepared.outcomes.get("pub-skill")?.state, "active");
    const afterOp = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        args: string[];
        env: Record<string, string | null>;
    });
    const opClone = afterOp.find((entry) => entry.args.includes(operatorGitUrl));
    assert.ok(opClone !== undefined, "operator ssh git definition cloned");
    assert.equal(opClone.env.SSH_AUTH_SOCK, "/tmp/operator-ssh.sock");
    assert.equal(opClone.env.GIT_ALLOW_PROTOCOL, null);
});

test("{§skills-module} {§module-contract} invalid confinement knobs are contained on startup and fail closed", async () => {
    for (const [override, key] of [
        [{ PLURNK_SKILLS_WORKSPACE_SOURCES: "archive" }, "PLURNK_SKILLS_WORKSPACE_SOURCES"],
        [{ PLURNK_SKILLS_PUBLIC_ONLY: "maybe" }, "PLURNK_SKILLS_PUBLIC_ONLY"],
    ] as const) {
        const env = { ...floor, ...override };
        const mod = Module.init({ env });
        assert.deepEqual(mod.contained.map((item) => item.key), [key]);
        const family = new SkillsFunctionality({
            workspacePaths: async () => ({ home: "/tmp", projectRoot: null, configurationRoots: [] }),
            readProvidedSkills: async () => new Map(),
            workspaceStateDirectory: async () => "/tmp",
            operatorEnvironment: () => ({}),
        }, { env });
        assert.deepEqual(family.policy(), { workspaceSources: [], publicOnly: true });
        await rejectsProblem(() => family.discover({ source: "forge:///skills" }, { workspaceId: 1 }), "configuration-invalid", 503);
        await rejectsProblem(() => family.admit({ alias: "a", source: "forge:///skills/a" }, { workspaceId: 1 }), "configuration-invalid", 503);
    }
});
