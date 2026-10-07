import test from "node:test";
import assert from "node:assert/strict";
import { auditProduction } from "./release-consumer.mjs";

test("{§release-candidate-graph} audit checks the selected production install with bounded network work", async () => {
    let called = false;
    await auditProduction("/candidate/consumer", { run: async (command, args, options) => {
        called = true;
        assert.equal(command, "npm");
        assert.deepEqual(args, ["audit", "--audit-level=moderate", "--omit=dev"]);
        assert.equal(options.cwd, "/candidate/consumer");
        assert.equal(options.env.npm_config_fetch_retries, "0");
        assert.equal(options.env.npm_config_fetch_timeout, "60000");
    } });
    assert.equal(called, true);
});

test("{§release-candidate-graph} real audit findings and unexpected failures retain their cause", async () => {
    for (const stderr of ["found 2 vulnerabilities (1 moderate, 1 high)", "invalid lockfile"]) {
        const failure = Object.assign(new Error("npm audit failed"), { stderr });
        await assert.rejects(auditProduction("/candidate/consumer", { run: async () => { throw failure; } }), (error) => error === failure);
    }
});

test("{§release-candidate-graph} an unreachable advisory service is reported rather than called clean", async () => {
    const warnings = [];
    await auditProduction("/candidate/consumer", {
        run: async () => { throw Object.assign(new Error("network"), { stderr: "npm warn audit network timeout" }); },
        warn: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /audit UNREACHABLE.*continuing/);
});
