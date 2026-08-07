import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release lifecycle stamps, commits, then builds and gates before script-free publication", async () => {
    const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const versionSteps = root.scripts["release:version"];
    assert.equal(versionSteps, "node scripts/release-prepare.mjs");
    assert.equal(root.scripts["release:check"], "node scripts/release-check.mjs");

    const prepare = await readFile(new URL("./release-prepare.mjs", import.meta.url), "utf8");
    assert.match(prepare, /\["scripts\/release-version\.mjs", version\]/);
    assert.doesNotMatch(prepare, /release-gates|npm", \["run", "build"/);
    const check = await readFile(new URL("./release-check.mjs", import.meta.url), "utf8");
    assert.match(check, /usage: release-check\.mjs <client-version>/);
    const preBuildClean = check.indexOf('assertClean("before build")');
    const serviceAuthority = check.indexOf('assertReleaseRepository(root, "plurnk-service")');
    const npmAuthority = check.indexOf("assertNpmPublisher(root)");
    const clientPreflight = check.indexOf('[clientRelease, "--check", clientVersion, version]');
    const build = check.indexOf('["run", "build"]');
    const drill = check.indexOf('["test"]');
    const gates = check.indexOf('["scripts/release-gates.mjs"]');
    const externalCheck = check.indexOf('["scripts/release-external-packages.mjs", "--check"]');
    const postGateClean = check.indexOf('assertClean("after gates")');
    assert.ok(preBuildClean >= 0 && preBuildClean < serviceAuthority);
    assert.ok(serviceAuthority < npmAuthority && npmAuthority < clientPreflight && clientPreflight < build);
    assert.ok(build < drill && drill < gates && gates < externalCheck && externalCheck < postGateClean);
    assert.match(check, /resolveExternalReposRoot\(process\.env\)/);
    assert.match(check, /RELEASE_PROBE_PORT/);

    const publish = await readFile(new URL("./release-publish.mjs", import.meta.url), "utf8");
    assert.match(publish, /usage: release-publish\.mjs <client-version>/);
    const qualification = publish.indexOf('["scripts/release-check.mjs", clientVersion]');
    const mutationClean = publish.indexOf('assertClean("before publication")');
    const firstPublish = publish.indexOf('["publish", "-w", name');
    assert.ok(qualification >= 0 && qualification < mutationClean && mutationClean < firstPublish);
    assert.doesNotMatch(publish, /\["run", "build"\]|\["scripts\/release-gates\.mjs"\]/);
    assert.match(publish, /\["publish", "-w", name, "--access", "public", "--ignore-scripts"\]/);

    const consumerInstall = publish.indexOf('["i", `${ROOT_PKG}@${version}`]');
    const dependencyGraph = publish.indexOf('["ls", "--all"]');
    const installedBoot = publish.indexOf('spawn("npx", ["plurnk-service"]');
    assert.ok(firstPublish < consumerInstall && consumerInstall < dependencyGraph && dependencyGraph < installedBoot);
    assert.match(publish, /PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled"/);
    assert.match(publish, /stdio: "inherit"/);

    const clientPublish = publish.indexOf("[CLIENT_RELEASE, clientVersion, version]");
    const exactComposition = publish.indexOf("PLURNK_COMPOSITION_CLIENT: `${CLIENT_PKG}@${clientVersion}`");
    const externals = publish.indexOf('["scripts/release-external-packages.mjs"]');
    assert.ok(firstPublish < clientPublish && clientPublish < exactComposition && exactComposition < externals);
    assert.doesNotMatch(publish, /@latest/);

    const gateSweep = await readFile(new URL("./release-gates.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(gateSweep, /prepublishOnly/);
    assert.match(gateSweep, /\["audit", "--audit-level=moderate"\]/);
    assert.match(gateSweep, /pkg\.scripts\?\.\["release:check"\]/);
    const buildPolicy = gateSweep.indexOf('["scripts/package-build-policy.mjs"]');
    const packedCandidates = gateSweep.indexOf('["scripts/package-provenance.mjs", "--pack"]');
    assert.ok(buildPolicy >= 0 && buildPolicy < packedCandidates);
    assert.match(
        gateSweep,
        /\["scripts\/package-provenance\.mjs", "--pack"\]/,
        "the pre-publication sweep inspects metadata from exact candidate archives",
    );

    const externalSweep = await readFile(new URL("./release-external-packages.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(externalSweep, /--dry-run/);
    assert.match(externalSweep, /assertReleaseRepository\(repo, dir\)/);
    assert.match(externalSweep, /assertNpmPublisher\(MONOREPO\)/);
    const checkBranch = externalSweep.indexOf("if (CHECK)");
    const firstWrite = externalSweep.indexOf("await alignManagedPackage(repo)");
    assert.ok(checkBranch >= 0 && checkBranch < firstWrite, "external check exits before local alignment");
});
