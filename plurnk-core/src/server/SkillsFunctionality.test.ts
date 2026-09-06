// {§skills-functionality} The installer's listing and registry boundaries.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseListing, StandardSkillsToolchain } from "./SkillsFunctionality.ts";


test("parseListing reads only the Available Skills structure behind the CLI's gutter and colors", () => {
    const output = [
        "[?25l│",
        "◇   claude-code_2-1-241_agent  Agent detected — installing non-interactively",
        "◇  Source: https://github.com/acme/kit.git",
        "◇  Found 2 skills",
        "",
        "│",
        "◇  Available Skills",
        "│",
        "│    [36mdeploy-to-vercel[0m",
        "│",
        "│      Deploy applications and websites to Vercel. Use when the user",
        "│      requests deployment actions.",
        "│",
        "│    Not A Name",
        "│",
        "│    vercel-optimize",
        "│",
        "│      Cost and performance optimization.",
        "",
        "└  Use --skill <name> to install specific skills",
    ].join("\n");
    assert.deepEqual(parseListing(output), [
        { name: "deploy-to-vercel", description: "Deploy applications and websites to Vercel. Use when the user requests deployment actions." },
        { name: "vercel-optimize", description: "Cost and performance optimization." },
    ]);
    assert.deepEqual(parseListing("◇  Found 0 skills\n"), []);
});

test("StandardSkillsToolchain reads the registry's JSON into exact candidates and refuses when disabled", async () => {
    const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ skills: [
            { name: "alpha", id: "acme/kit/alpha", source: "acme/kit", installs: 7 },
            { name: "beta", id: "acme/kit/beta", installs: "many" },
            { bogus: true },
        ] }));
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const { port } = server.address() as { port: number };
    try {
        const toolchain = new StandardSkillsToolchain({ PLURNK_SERVICE_SKILLS_CLI: "skills-fixture", PLURNK_SERVICE_SKILLS_REGISTRY_URL: `http://127.0.0.1:${port}///` });
        assert.equal(toolchain.registry, `http://127.0.0.1:${port}`);
        assert.deepEqual(await toolchain.search("al"), [
            { name: "alpha", id: "acme/kit/alpha", source: "acme/kit", installs: 7 },
            { name: "beta", id: "acme/kit/beta", source: "acme/kit", installs: null },
        ]);
        const disabled = new StandardSkillsToolchain({ PLURNK_SERVICE_SKILLS_REGISTRY_URL: "  " });
        assert.equal(disabled.registry, null);
        await assert.rejects(() => disabled.search("x"), (error: { problem?: { type?: string; status?: number } }) =>
            error.problem?.type === "https://problems.plurnk.xyz/skills/functionality/registry-not-configured" && error.problem.status === 501);
        const unreachable = new StandardSkillsToolchain({ PLURNK_SERVICE_SKILLS_REGISTRY_URL: "http://127.0.0.1:9" });
        await assert.rejects(() => unreachable.search("x"), (error: { problem?: { type?: string } }) =>
            error.problem?.type === "https://problems.plurnk.xyz/skills/functionality/registry-unreachable");
    } finally {
        await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    }
});
