import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PluginConfiguration from "./PluginConfiguration.ts";

test("{§mcp-plugin-configuration} plugin stdio interpretation is literal except for the two reserved placeholders", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-plugin-${UNEXPANDED}-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const context = { root: join(directory, "plugin"), data: join(directory, "data") };
    await mkdir(context.root);
    const source = {
        name: "tool", type: "stdio" as const, command: "./bin/tool", cwd: "${PLUGIN_DATA}",
        args: ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "${SECRET}", "${PLUGIN_ROOT}/${PLUGIN_ROOT}"],
        env: { SAMPLE: "${PLUGIN_DATA}", LITERAL: "${SECRET}" },
    };
    const resolved = PluginConfiguration.resolve(source, context);
    assert.deepEqual(resolved, {
        type: "stdio", command: join(context.root, "bin/tool"), cwd: context.data,
        args: [context.root, context.data, "${SECRET}", `${context.root}/${context.root}`],
        env: { SAMPLE: context.data, LITERAL: "${SECRET}", PLUGIN_ROOT: context.root, PLUGIN_DATA: context.data },
    });
    await PluginConfiguration.prepare(source, context);
    await access(context.data);
    assert.equal(PluginConfiguration.resolve({ name: "tool", type: "stdio", command: "node" }, context).cwd, context.root);
    assert.equal(PluginConfiguration.resolve({ name: "tool", type: "stdio", command: "${COMMAND}" }, context).command, "${COMMAND}");
});

test("{§mcp-plugin-configuration} plugin paths are checked at launch without interpreting opaque arguments", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-plugin-paths-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const context = { root: join(directory, "plugin"), data: join(directory, "data") };
    await mkdir(context.root);
    await mkdir(context.data);
    const source = { name: "tool", type: "stdio" as const, command: "node", args: ["../../opaque"], env: { OPAQUE: "../../opaque" } };
    await PluginConfiguration.prepare(source, context);
    for (const cwd of ["./../outside", "${PLUGIN_ROOT}/../outside", "${PLUGIN_DATA}/../outside"]) {
        await assert.rejects(PluginConfiguration.prepare({ ...source, cwd }, context), /cwd resolves outside/u);
    }
    await symlink(directory, join(context.root, "escape"));
    await symlink(directory, join(context.data, "escape"));
    await assert.rejects(PluginConfiguration.prepare({ ...source, command: "./escape/tool" }, context), /command resolves outside/u);
    await assert.rejects(PluginConfiguration.prepare({ ...source, cwd: "${PLUGIN_DATA}/escape" }, context), /cwd resolves outside/u);
});
