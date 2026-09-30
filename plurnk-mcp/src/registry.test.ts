// {§mcp-registry-discovery} — a registry server's packages and remotes as standard mcp.json entries.
import test from "node:test";
import assert from "node:assert/strict";
import { aliasOf, registryEntries, type RegistryServer } from "./registry.ts";

test("{§mcp-registry-discovery} a registry name's last segment is the alias plurnk spells", () => {
    assert.equal(aliasOf("io.github.example/example-server"), "example-server");
    assert.equal(aliasOf("io.github.example/Example_Server"), "example-server");
    assert.equal(aliasOf("com.example/2fa-tools"), "fa-tools");
    assert.equal(aliasOf("com.example/123"), null);
});

test("{§mcp-registry-discovery} each launchable package and Streamable HTTP remote becomes one self-contained entry", () => {
    const server: RegistryServer = {
        name: "io.github.example/example-server",
        version: "1.2.3",
        description: "Search the example index.",
        packages: [
            {
                registryType: "npm", identifier: "@example/server", version: "1.2.3", runtimeHint: "npx", transport: { type: "stdio" },
                packageArguments: [{ type: "positional", value: "serve" }, { type: "named", name: "--port", default: "3000" }, { type: "named", name: "--verbose" }],
                environmentVariables: [{ name: "EXAMPLE_API_KEY", isRequired: true, isSecret: true }, { name: "EXAMPLE_REGION", isRequired: true, default: "eu" }],
            },
            { registryType: "pypi", identifier: "example-server", version: "0.5.0", runtimeHint: "uvx", transport: { type: "stdio" } },
            { registryType: "oci", identifier: "docker.io/example/server:1.2.3", version: "1.2.3", transport: { type: "stdio" }, environmentVariables: [{ name: "EXAMPLE_API_KEY" }] },
            { registryType: "nuget", identifier: "Example.Server", version: "0.5.0", runtimeHint: "dnx", transport: { type: "stdio" } },
        ],
        remotes: [
            { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Tenant", value: "public" }, { name: "X-Api-Key", isRequired: true, isSecret: true }] },
        ],
    };
    assert.deepEqual(registryEntries(server).map(({ entry }) => entry), [
        { type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3", "serve", "--port", "3000"] },
        { type: "stdio", command: "uvx", args: ["example-server@0.5.0"] },
        { type: "stdio", command: "docker", args: ["run", "-i", "--rm", "-e", "EXAMPLE_API_KEY", "docker.io/example/server:1.2.3"] },
        { type: "stdio", command: "dnx", args: ["Example.Server@0.5.0"] },
        { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "public" } },
    ]);
    const [npm, , , , remote] = registryEntries(server);
    assert.equal(npm?.alias, "example-server");
    assert.equal(npm?.reference, "io.github.example/example-server@1.2.3");
    assert.match(npm?.summary ?? "", /^Search the example index\. — npx -y @example\/server@1\.2\.3 serve --port 3000 — Needs EXAMPLE_API_KEY\.$/u,
        "the summary names what the environment must supply, and a variable with a default needs nothing");
    assert.match(remote?.summary ?? "", /Needs the X-Api-Key header\.$/u, "a secret header is never an entry's literal");
});

test("{§mcp-registry-discovery} what needs a person's input first, and what plurnk cannot launch, has no entry", () => {
    const base = { name: "io.github.example/example-server", version: "1.0.0" };
    const none = (server: Omit<RegistryServer, "name" | "version">): void =>
        assert.deepEqual(registryEntries({ ...base, ...server }), [], JSON.stringify(server));
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "stdio" }, packageArguments: [{ type: "positional", value: "{target_dir}" }] }] });
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "stdio" }, packageArguments: [{ type: "positional", isRequired: true }] }] });
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "streamable-http" } }] });
    none({ packages: [{ registryType: "mcpb", identifier: "https://example.com/server.mcpb", version: "1.0.0", transport: { type: "stdio" } }] });
    none({ remotes: [{ type: "sse", url: "https://mcp.example.com/sse" }] });
    none({ remotes: [{ type: "streamable-http", url: "https://mcp.example.com/{tenant}/mcp" }] });
});
