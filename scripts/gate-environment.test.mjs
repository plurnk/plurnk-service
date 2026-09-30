import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { serviceDefinitions } from "../plurnk-mcp/src/config.ts";
import { gateResourceEnvironment } from "./gate-environment.mjs";

test("{§operator-config-real-model-profile} personal resources stay inspectable but do not activate in disposable runs", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-gate-environment-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, ".env");
    const source = [
        'PLURNK_MCP_web_search={"name":"web-search","type":"stdio","command":"node"}',
        "PLURNK_MCP_web_search_ENABLED=1",
        'PLURNK_MCP_future_TOOLS=["search"]',
        'PLURNK_A2A_peer={"name":"peer","url":"https://example.com"}',
        'PLURNK_SCHEDULE_check={"unused":"fixture"}',
        "PLURNK_MEMBERS_docs=docs/**",
        'PLURNK_SKILLS_3d_tools={"name":"3d-tools","source":"/srv/3d-tools"}',
        'PLURNK_SKILLS_分析={"name":"分析","source":"/srv/分析"}',
        "PLURNK_SKILLS_分析_ENABLED=1",
        "PLURNK_SKILLS_ENABLED=1",
        "PLURNK_MODEL=selected",
        "PLURNK_PROVIDERS_OUTPUT_BUDGET=16384",
        "PROVIDER_API_KEY=fixture-secret",
        "",
    ].join("\n");
    await writeFile(path, source);
    const environment = { PLURNK_MCP_web_search_ENABLED: "1", PLURNK_MODEL: "explicit" };
    assert.deepEqual(await gateResourceEnvironment(path, environment), {
        PLURNK_MCP_future_ENABLED: "0",
        PLURNK_A2A_peer_ENABLED: "0",
        PLURNK_SCHEDULE_check_ENABLED: "0",
        PLURNK_MEMBERS_docs_ENABLED: "0",
        PLURNK_SKILLS_3d_tools_ENABLED: "0",
        PLURNK_SKILLS_分析_ENABLED: "0",
    });
    assert.deepEqual(environment, { PLURNK_MCP_web_search_ENABLED: "1", PLURNK_MODEL: "explicit" });
    const personal = parseEnv(source);
    const disabled = await gateResourceEnvironment(path, {});
    assert.deepEqual(serviceDefinitions({ ...personal, PLURNK_MCP_ENABLED: "0", ...disabled }), [{
        alias: "web-search", enabled: false,
        definition: { name: "web-search", type: "stdio", command: "node" },
        provenance: { kind: "environment", source: "PLURNK_MCP_web_search" },
    }]);
    assert.equal(serviceDefinitions({ ...personal, PLURNK_MCP_ENABLED: "0", ...disabled, ...environment })[0].enabled, true);
    assert.equal(await readFile(path, "utf8"), source);
    assert.deepEqual(await gateResourceEnvironment(join(directory, "absent"), {}), {});
    await assert.rejects(gateResourceEnvironment(directory, {}), { code: "EISDIR" });
});
