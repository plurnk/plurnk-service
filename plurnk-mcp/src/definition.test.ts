import test from "node:test";
import assert from "node:assert/strict";
import { readDefinition } from "./definition.ts";

test("{§mcp-server-definition} direct commands, symbolic authentication and custom headers share one admission path", () => {
    for (const command of ["node", "/usr/bin/node", "./bin/server"]) {
        assert.deepEqual(readDefinition({ name: "local", type: "stdio", command }), { name: "local", type: "stdio", command });
    }
    const definition = { name: "forge", type: "streamable-http", url: "https://example.com/mcp", authorization: { type: "bearer", token: "${TOKEN}" }, headers: { "X-Tenant": "${TENANT}" } };
    assert.deepEqual(readDefinition(definition), definition);
    assert.notEqual(readDefinition(definition), definition);
    assert.throws(() => readDefinition({ ...definition, headers: { aUtHoRiZaTiOn: "Bearer ${TOKEN}" } }), /cannot supply both authorization and an Authorization header/u);
    for (const url of ["https://", "http://example.com/mcp", "file:///tmp/server"]) {
        assert.throws(() => readDefinition({ ...definition, url }), TypeError);
    }
    for (const url of ["http://localhost/mcp", "http://127.0.0.1/mcp", "http://[::1]/mcp"]) {
        assert.equal(readDefinition({ ...definition, url }).type, "streamable-http");
    }
});
