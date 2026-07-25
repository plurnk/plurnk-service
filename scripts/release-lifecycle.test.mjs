import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release lifecycle builds and gates once before script-free publication", async () => {
    const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const versionSteps = root.scripts["release:version"];
    assert.match(versionSteps, /npm run build && node scripts\/release-gates\.mjs/);

    const publish = await readFile(new URL("./release-publish.mjs", import.meta.url), "utf8");
    assert.match(publish, /\["publish", "-w", name, "--access", "public", "--ignore-scripts"\]/);
});
