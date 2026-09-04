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
    assert.match(check, /probe=child-owned ephemeral listener/);

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
    const installedBoot = publish.indexOf("probeInstalledDaemon({");
    const externals = publish.indexOf('["scripts/release-external-packages.mjs"]');
    assert.ok(firstPublish < externals && externals < consumerInstall,
        "managed dependency leaves publish after their platform owner and before its clean consumer install");
    assert.ok(consumerInstall < dependencyGraph && dependencyGraph < installedBoot);
    assert.match(publish, /node_modules", "\.bin", "plurnk-service"/);
    assert.match(publish, /packageName: ROOT_PKG/);
    assert.doesNotMatch(publish, /RELEASE_PROBE_PORT|BOOT_PORT/);

    const clientPublish = publish.indexOf("[CLIENT_RELEASE, clientVersion, version]");
    const exactComposition = publish.indexOf("PLURNK_COMPOSITION_CLIENT: `${CLIENT_PKG}@${clientVersion}`");
    assert.ok(installedBoot < clientPublish && clientPublish < exactComposition);
    assert.doesNotMatch(publish, /@latest/);

    const gateSweep = await readFile(new URL("./release-gates.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(gateSweep, /prepublishOnly/);
    assert.match(gateSweep, /\["audit", "--audit-level=moderate"\]/);
    assert.match(gateSweep, /npm_config_fetch_retries: "0"/, "the one deliberate audit never retries into a drop-limit (#649)");
    assert.match(gateSweep, /npm_config_fetch_timeout: "60000"/, "the audit fails fast and never hangs a release (#649)");
    assert.match(gateSweep, /audit UNREACHABLE[\s\S]*continuing/, "an unreachable advisory endpoint warns and continues (#649)");
    const [, unreachable] = gateSweep.match(/const unreachable = \/(.+)\/iu\.test\(text\)/) ?? [];
    assert.ok(unreachable, "the unreachable classifier is one inline regex (#649)");
    const dropped = "npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\nnpm error audit endpoint returned an error";
    assert.ok(new RegExp(unreachable, "iu").test(dropped), "npm's actual audit timeout text classifies as unreachable (#649)");
    assert.ok(!new RegExp(unreachable, "iu").test("found 3 vulnerabilities (1 moderate, 2 high)"), "a genuine finding never classifies as unreachable (#649)");
    assert.match(gateSweep, /\["scripts\/package-publint\.mjs"\]/);
    assert.match(gateSweep, /pkg\.scripts\?\.\["release:check"\]/);
    const buildPolicy = gateSweep.indexOf('["scripts/package-build-policy.mjs"]');
    const packedCandidates = gateSweep.indexOf('["scripts/package-provenance.mjs", "--pack"]');
    const packageShape = gateSweep.indexOf('["scripts/package-publint.mjs"]');
    const dependencyAudit = gateSweep.indexOf('["audit", "--audit-level=moderate"]');
    assert.ok(buildPolicy >= 0 && buildPolicy < packedCandidates);
    assert.ok(packedCandidates < packageShape && packageShape < dependencyAudit);
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
