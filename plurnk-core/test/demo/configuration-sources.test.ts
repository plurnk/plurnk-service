// {§configuration-definition-resolution} {§configuration-provenance}
import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";

test("demo: configured skill sources survive a model's workspace override and removal", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-demo-config-sources-"));
    const name = "source-review";
    const key = "PLURNK_SKILLS_source_review";
    const baseline = join(root, "configured", name);
    const replacement = join(root, "replacement", name);
    const markers = ["BASELINE_" + crypto.randomUUID(), "REPLACEMENT_" + crypto.randomUUID()];
    const documents = markers.map((marker) => `---\nname: ${name}\ndescription: Report this review skill's verification marker.\n---\nWhen asked to follow this skill, report the exact marker: ${marker}\n`);
    const saved = new Map([key, `${key}_ENABLED`].map((name) => [name, process.env[name]]));
    t.after(async () => {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        await rm(root, { recursive: true, force: true });
    });
    for (const [index, directory] of [baseline, replacement].entries()) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), documents[index]);
    }
    process.env[key] = JSON.stringify({ name, source: baseline });
    process.env[`${key}_ENABLED`] = "0";
    const s = await liveWorkspace({ name: `demo-config-sources-${crypto.randomUUID()}`, projectRoot: root });
    try {
        let workerId: number | undefined;
        let requestId = 2;
        const run = async (prompt: string, marker: string) => {
            const result = await liveLoop(s, requestId++, { prompt, workerId, maxTurns: 8 }, { signal: t.signal });
            workerId = result.modelWorkerId;
            assert.equal(result.finalStatus, 200, "the configuration request concludes cleanly");
            assert.ok(result.lastContent.includes(marker), "the answer contains the marker from the effective skill");
            return result.lastContent;
        };
        const effective = async () => {
            const listed = await s.invokeWorkspaceAction("workspace.skills.list", {}) as FunctionalityListResult;
            return listed.definitions.find(({ alias }) => alias === name);
        };
        await run(`An available skill named ${name} is disabled. Enable it for this workspace, follow its instructions, and report its verification marker.`, markers[0]);
        assert.equal((await effective())?.state, "active");
        assert.equal((await effective())?.origin, "service");
        await run(`For this workspace, temporarily replace ${name} with the local skill at ${replacement}. Follow the replacement and report its verification marker. Do not change either source folder.`, markers[1]);
        assert.equal((await effective())?.origin, "workspace");
        assert.deepEqual((await effective())?.definition, { name, source: replacement });
        const answer = await run(`Remove that workspace override so ${name} inherits its original configuration again. Leave the original skill enabled, follow it, and report both its verification marker and the configuration key supplying it. Do not modify configuration files or either source folder.`, markers[0]);
        assert.ok(answer.includes(key), "the model locates the winning input through ordinary inspection");
        assert.deepEqual(await effective(), {
            alias: name, origin: "service", state: "active", definition: { name, source: baseline },
            provenance: { kind: "environment", source: key },
            detail: { description: "Report this review skill's verification marker.", path: baseline },
        });
        for (const [index, directory] of [baseline, replacement].entries()) {
            assert.equal(await readFile(join(directory, "SKILL.md"), "utf8"), documents[index], "configuration mutations preserve source files");
        }
    } finally { await s.cleanup(); }
});
