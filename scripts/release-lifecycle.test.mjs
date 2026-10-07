import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { publishCandidates } from "./release-registry.mjs";

const records = () => [
    { name: "consumer", version: "4.3.0", manifest: { name: "consumer", version: "4.3.0", dependencies: { contract: "^2.0.0" } } },
    { name: "contract", version: "2.1.0", manifest: { name: "contract", version: "2.1.0" } },
].map((record) => ({ ...record, commit: "a".repeat(40), integrity: `sha512-${record.name}` }));
const published = ({ name, version, commit, integrity }) => ({ name, version, gitHead: commit, dist: { integrity } });

test("{§release-candidate-graph} publication follows dependency identities without changing sources or versions", async () => {
    const selected = records();
    const original = structuredClone(selected);
    const registry = new Map();
    const calls = [];
    await publishCandidates(selected, {
        lookup: async (name, version) => {
            assert.ok(selected.some((record) => record.name === name && record.version === version));
            return registry.get(name);
        },
        publish: async (record) => { calls.push(record.name); registry.set(record.name, published(record)); },
    });
    assert.deepEqual(calls, ["contract", "consumer"]);
    assert.deepEqual(selected, original);
});

test("{§release-candidate-graph} an interrupted publication resumes only its missing immutable artifacts", async () => {
    const selected = records();
    const registry = new Map();
    const calls = [];
    const lookup = async (name) => registry.get(name);
    await assert.rejects(publishCandidates(selected, { lookup, publish: async (record) => {
        calls.push(record.name);
        if (record.name === "consumer") throw new Error("publication refused");
        registry.set(record.name, published(record));
    } }), /publication refused/);
    assert.deepEqual(calls, ["contract", "consumer"]);
    calls.length = 0;
    await publishCandidates(selected, { lookup, publish: async (record) => {
        calls.push(record.name);
        registry.set(record.name, published(record));
    } });
    assert.deepEqual(calls, ["consumer"]);
    assert.equal(registry.size, 2);
});

test("{§release-candidate-graph} independent packages upload before waiting, but consumers require verified dependencies", async () => {
    const selected = [...records(), { name: "independent", version: "1.0.0", manifest: { name: "independent", version: "1.0.0" }, commit: "a".repeat(40), integrity: "sha512-independent" }];
    const calls = [];
    const uploaded = new Map();
    const visible = new Map();
    await publishCandidates(selected, {
        lookup: async (name) => visible.get(name),
        publish: async (record) => { calls.push(`publish ${record.name}`); uploaded.set(record.name, published(record)); },
        wait: async ({ name }) => { calls.push(`verify ${name}`); visible.set(name, uploaded.get(name)); },
    });
    assert.deepEqual(calls, ["publish contract", "publish independent", "verify contract", "verify independent", "publish consumer", "verify consumer"]);
});

test("{§release-candidate-graph} registry uncertainty and immutable conflicts prevent every upload", async () => {
    for (const failure of ["network", "conflict"]) {
        const calls = [];
        const selected = records();
        await assert.rejects(publishCandidates(selected, {
            lookup: async (name) => {
                if (name !== "contract") return undefined;
                if (failure === "network") throw new Error("network unavailable");
                return { ...published(selected[1]), dist: { integrity: "different" } };
            },
            publish: async (record) => calls.push(record.name),
        }), /network unavailable|artifact differs/);
        assert.deepEqual(calls, []);
    }
});

test("{§release-candidate-graph} invisible or altered publication stops before its consumers", async () => {
    for (const failure of ["visibility", "changed"]) {
        const calls = [];
        const registry = new Map();
        await assert.rejects(publishCandidates(records(), {
            lookup: async (name) => registry.get(name),
            publish: async (record) => {
                calls.push(record.name);
                registry.set(record.name, { ...published(record), dist: { integrity: "different" } });
            },
            wait: async () => { if (failure === "visibility") throw new Error("visibility exhausted"); },
        }), /visibility exhausted|artifact differs/);
        assert.deepEqual(calls, ["contract"]);
    }
});

test("{§release-candidate-graph} incompatible candidate edges cannot publish partially", async () => {
    const selected = records();
    selected[0].manifest.dependencies.contract = "^1.0.0";
    const calls = [];
    await assert.rejects(publishCandidates(selected, {
        lookup: async () => undefined,
        publish: async (record) => calls.push(record.name),
    }), /excludes candidate/);
    assert.deepEqual(calls, []);
});

test("release qualification audits the installed composition and retains package-owned checks", async () => {
    const gates = await readFile(new URL("./release-gates.mjs", import.meta.url), "utf8");
    const consumer = await readFile(new URL("./release-consumer.mjs", import.meta.url), "utf8");
    assert.match(consumer, /\["install", "--no-audit", "--no-fund", "--include=peer", \.\.\.specs\]/);
    assert.match(consumer, /await auditProduction\(cwd\)/);
    assert.match(consumer, /\["audit", "--audit-level=moderate", "--omit=dev"\]/);
    assert.match(consumer, /npm_config_fetch_retries: "0"/);
    assert.match(consumer, /npm_config_fetch_timeout: "60000"/);
    assert.match(consumer, /audit UNREACHABLE[\s\S]*continuing/);
    const [, classifier] = consumer.match(/const unreachable = \/(.+)\/iu\.test\(text\)/);
    assert.ok(new RegExp(classifier, "iu").test("npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk"));
    assert.ok(!new RegExp(classifier, "iu").test("found 3 vulnerabilities (1 moderate, 2 high)"));
    assert.match(gates, /\["scripts\/package-provenance\.mjs", "--pack"\]/);
    assert.match(gates, /\["scripts\/package-publint\.mjs"\]/);
    assert.match(gates, /pkg\.scripts\?\.\["release:check"\]/);
});
