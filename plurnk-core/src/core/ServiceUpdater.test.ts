import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lookup, resetCatalog } from "@plurnk/plurnk-models";
import HostPaths from "./HostPaths.ts";
import { OperationFailureError } from "./results.ts";
import ServiceUpdater from "./ServiceUpdater.ts";

test("{§service-update} refuses update with 403 update-disabled when PLURNK_SERVICE_UPDATEABLE=0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plurnk-service-update-disabled-"));
    try {
        const hostPaths = new HostPaths({ home: dir, env: { PLURNK_SERVICE_STATE_ROOT: dir } });
        await assert.rejects(
            () => ServiceUpdater.run({
                env: { PLURNK_SERVICE_UPDATEABLE: "0" },
                hostPaths,
            }),
            (err: unknown) => {
                assert.ok(err instanceof OperationFailureError);
                assert.equal(err.result.status, 403);
                assert.equal(err.result.problem.type, "https://problems.plurnk.xyz/daemon/update/update-disabled");
                assert.match(err.message, /PLURNK_SERVICE_UPDATEABLE=0/);
                return true;
            },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("{§service-update} updates cached model catalog and reports source checkout or npm install status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plurnk-service-update-run-"));
    try {
        const hostPaths = new HostPaths({ home: dir, env: { PLURNK_SERVICE_STATE_ROOT: dir } });
        const fakeApi = {
            openai: {
                id: "openai",
                name: "OpenAI",
                npm: "@ai-sdk/openai",
                env: ["OPENAI_API_KEY"],
                models: {
                    "gpt-update-test": {
                        name: "GPT Update Test",
                        reasoning: true,
                        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
                        attachment: true,
                        tool_call: true,
                        modalities: { input: ["text"], output: ["text"] },
                        limit: { context: 256000, output: 32000 },
                    },
                },
            },
        };
        const fakeFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(fakeApi), {
            status: 200,
            headers: { "content-type": "application/json", etag: '"etag-update-1"' },
        });

        const sourceResult = await ServiceUpdater.run({
            env: { PLURNK_SERVICE_UPDATEABLE: "1" },
            hostPaths,
            fetch: fakeFetch,
            buildInfo: {
                package: "@plurnk/plurnk-service",
                version: "4.4.0",
                artifact: "source",
                path: dir,
                revision: "deadbeef",
                dirty: false,
            },
        });
        assert.equal(sourceResult.catalog.status, "updated");
        assert.equal(sourceResult.npm.status, "source");
        assert.equal(lookup("openai", "gpt-update-test")?.name, "GPT Update Test");
        assert.match(ServiceUpdater.formatReport(sourceResult), /catalog: updated/);
        assert.match(ServiceUpdater.formatReport(sourceResult), /source checkout/);

        const distResult = await ServiceUpdater.run({
            env: { PLURNK_SERVICE_UPDATEABLE: "1" },
            hostPaths,
            fetch: async () => new Response(null, { status: 304 }),
            buildInfo: {
                package: "@plurnk/plurnk-service",
                version: "4.4.0",
                artifact: "dist",
                path: dir,
            },
            npmInstall: async () => "4.5.0",
        });
        assert.equal(distResult.catalog.status, "unchanged");
        assert.equal(distResult.npm.status, "updated");
        assert.equal(distResult.npm.previousVersion, "4.4.0");
        assert.equal(distResult.npm.currentVersion, "4.5.0");
        assert.match(ServiceUpdater.formatReport(distResult), /4\.4\.0 -> 4\.5\.0/);
    } finally {
        resetCatalog();
        rmSync(dir, { recursive: true, force: true });
    }
});
