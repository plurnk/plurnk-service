// {§environment-layers} — one statement of the real-model cascade, and its precedence proven layer by layer.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyRealModelEnvironment, floorModule, gateProfile, realModelLayers, realModelNodeFlags } from "./environment.mjs";

const KEY = "PLURNK_ENVIRONMENT_WITNESS";

const stage = async (t, defined) => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-environment-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "plurnk-core"), { recursive: true });
    const operatorFile = path.join(root, "operator.env");
    const files = { defaults: path.join(root, "plurnk-core", ".env.defaults"), operator: operatorFile, gate: path.join(root, "plurnk-core", ".env.test") };
    for (const [layer, file] of Object.entries(files)) {
        if (layer in defined) await writeFile(file, `${KEY}=${defined[layer]}\n`);
    }
    return { root, operatorFile };
};

test("{§environment-layers} the layers run lowest to highest, and the flags say so", () => {
    const layers = realModelLayers("/repo", { operatorFile: "/home/op/.config/plurnk/.env" });
    assert.deepEqual(layers, ["/repo/plurnk-core/.env.defaults", "/home/op/.config/plurnk/.env", "/repo/plurnk-core/.env.test"]);
    assert.equal(gateProfile("/repo"), "/repo/plurnk-core/.env.test");
    assert.deepEqual(realModelNodeFlags("/repo", { operatorFile: "/home/op/.config/plurnk/.env" }), [
        `--import=${floorModule("/repo")}`,
        ...layers.map((layer) => `--env-file-if-exists=${layer}`),
    ]);
});

test("{§environment-layers} precedence: the gate profile over the operator file over the defaults, the shell over all", async (t) => {
    const cases = [
        [{ defaults: "d" }, "d"],
        [{ operator: "o" }, "o"],
        [{ gate: "g" }, "g"],
        [{ defaults: "d", operator: "o" }, "o"],
        [{ operator: "o", gate: "g" }, "g"],
        [{ defaults: "d", operator: "o", gate: "g" }, "g"],
        [{ defaults: "d", gate: "g" }, "g"],
    ];
    for (const [defined, expected] of cases) {
        await t.test(`${Object.keys(defined).join("+")} → ${expected}`, async (t) => {
            delete process.env[KEY];
            const { root, operatorFile } = await stage(t, defined);
            await applyRealModelEnvironment(root, { operatorFile, floor: false });
            assert.equal(process.env[KEY], expected);
            delete process.env[KEY];
        });
    }
    await t.test("shell → shell", async (t) => {
        process.env[KEY] = "shell";
        const { root, operatorFile } = await stage(t, { defaults: "d", operator: "o", gate: "g" });
        await applyRealModelEnvironment(root, { operatorFile, floor: false });
        assert.equal(process.env[KEY], "shell");
        delete process.env[KEY];
    });
    await t.test("a missing layer is skipped, not an error", async (t) => {
        delete process.env[KEY];
        const { root, operatorFile } = await stage(t, {});
        await applyRealModelEnvironment(root, { operatorFile, floor: false });
        assert.equal(process.env[KEY], undefined);
    });
});
