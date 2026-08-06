import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release lifecycle stamps, commits, then builds and gates before script-free publication", async () => {
    const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const versionSteps = root.scripts["release:version"];
    assert.equal(versionSteps, "node scripts/release-prepare.mjs");

    const prepare = await readFile(new URL("./release-prepare.mjs", import.meta.url), "utf8");
    assert.match(prepare, /\["scripts\/release-version\.mjs", version\]/);
    assert.doesNotMatch(prepare, /release-gates|npm", \["run", "build"/);
    const publish = await readFile(new URL("./release-publish.mjs", import.meta.url), "utf8");
    assert.match(publish, /usage: release-publish\.mjs <client-version>/);
    const preBuildClean = publish.indexOf('assertClean("before build")');
    const clientPreflight = publish.indexOf('[CLIENT_RELEASE, "--check", clientVersion, version]');
    const build = publish.indexOf('["run", "build"]');
    const gates = publish.indexOf('["scripts/release-gates.mjs"]');
    const postGateClean = publish.indexOf('assertClean("after gates")');
    const firstPublish = publish.indexOf('["publish", "-w", name');
    assert.ok(preBuildClean >= 0 && preBuildClean < clientPreflight && clientPreflight < build);
    assert.ok(build < gates && gates < postGateClean && postGateClean < firstPublish);
    assert.match(publish, /\["publish", "-w", name, "--access", "public", "--ignore-scripts"\]/);

    const consumerInstall = publish.indexOf('["i", `${ROOT_PKG}@${version}`]');
    const dependencyGraph = publish.indexOf('["ls", "--all"]');
    const installedBoot = publish.indexOf('spawn("npx", ["plurnk-service"]');
    assert.ok(firstPublish < consumerInstall && consumerInstall < dependencyGraph && dependencyGraph < installedBoot);
    assert.doesNotMatch(publish, /order\.length - 1|dep tree incomplete/);
    assert.match(publish, /PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled"/);
    assert.match(publish, /stdio: "inherit"/);

    const clientPublish = publish.indexOf("[CLIENT_RELEASE, clientVersion, version]");
    const exactComposition = publish.indexOf("PLURNK_COMPOSITION_CLIENT: `${CLIENT_PKG}@${clientVersion}`");
    const externals = publish.indexOf('["scripts/release-external-packages.mjs"]');
    assert.ok(firstPublish < clientPublish && clientPublish < exactComposition && exactComposition < externals);
    assert.doesNotMatch(publish, /@latest/);

    const gateSweep = await readFile(new URL("./release-gates.mjs", import.meta.url), "utf8");
    const buildPolicy = gateSweep.indexOf('["scripts/package-build-policy.mjs"]');
    const packedCandidates = gateSweep.indexOf('["scripts/package-provenance.mjs", "--pack"]');
    assert.ok(buildPolicy >= 0 && buildPolicy < packedCandidates);
    assert.match(
        gateSweep,
        /\["scripts\/package-provenance\.mjs", "--pack"\]/,
        "the pre-publication sweep inspects metadata from exact candidate archives",
    );
});
