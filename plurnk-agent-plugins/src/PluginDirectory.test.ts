import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PluginDirectory from "./PluginDirectory.ts";

interface ExpectedReport {
    readonly path: string;
    readonly section: string;
    readonly outcome: string;
}

interface Expected {
    readonly section: string;
    readonly requirement: string;
    readonly plugin: "accepted" | "rejected";
    readonly skills?: readonly string[];
    readonly mcpServers?: readonly string[] | null;
    readonly reports: readonly ExpectedReport[];
}

const CORPUS = fileURLToPath(new URL("../test/conformance/", import.meta.url));
const key = ({ path, section, outcome }: ExpectedReport): string => `${path}\u0000${section}\u0000${outcome}`;
const cases = (await readdir(CORPUS, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();

test("{§agent-plugins-conformance} the corpus holds one case per normative requirement", () => {
    assert.ok(cases.length >= 50, `expected the full corpus, found ${cases.length} cases`);
});

for (const name of cases) {
    const expected = JSON.parse(await readFile(join(CORPUS, name, "expected.json"), "utf8")) as Expected;
    test(`{§agent-plugins-conformance} §${expected.section} ${name}: ${expected.requirement}`, async () => {
        const { plugin, reports } = await PluginDirectory.load(join(CORPUS, name, "plugin"));
        assert.equal(plugin === null ? "rejected" : "accepted", expected.plugin);
        if (plugin !== null) {
            assert.deepEqual(plugin.skills.map((skill) => skill.document.name).toSorted(), expected.skills);
            assert.deepEqual(plugin.mcpServers === null ? null : [...plugin.mcpServers.keys()].toSorted(), expected.mcpServers);
        }
        assert.deepEqual(reports.map(key).toSorted(), expected.reports.map(key).toSorted());
    });
}

test("{§agent-plugins-reports} every report names its plugin directory and says what happened", async () => {
    const directory = join(CORPUS, "manifest-unknown-field", "plugin");
    const { reports } = await PluginDirectory.load(directory);
    assert.deepEqual(reports, [{
        root: directory, path: "plugin.json", section: "5.2", outcome: "ignored",
        message: "unknown top-level field \"displayName\" is ignored",
    }]);
});

test("{§agent-plugins-manifest} unknown fields never survive validation", async () => {
    const { plugin } = await PluginDirectory.load(join(CORPUS, "manifest-unknown-field", "plugin"));
    assert.deepEqual(plugin?.manifest, { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "unknown-field" });
});

test("{§agent-plugins-manifest} a non-object extensions field is dropped, not kept", async () => {
    const { plugin } = await PluginDirectory.load(join(CORPUS, "manifest-extensions-not-object", "plugin"));
    assert.equal(plugin?.manifest.extensions, undefined);
    assert.equal(plugin?.manifest.name, "extensions-string");
});

test("{§agent-plugins-scope} a directory that does not exist is rejected with a report", async () => {
    const directory = join(CORPUS, "no-such-case");
    const { plugin, reports } = await PluginDirectory.load(directory);
    assert.equal(plugin, null);
    assert.deepEqual(reports.map(({ path, section, outcome }) => ({ path, section, outcome })), [{ path: "", section: "11.1", outcome: "rejected" }]);
});
