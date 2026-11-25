import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    PROTOCOL_VERSION,
    RequestError,
    client as createRawAcpClient,
    methods,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { Problems, type ApplicationDaemonPolicy } from "@plurnk/plurnk-contracts";
import { WsConstructor, createAcpClient, createHarness } from "../test/harness.ts";

describe("{§acp-daemon-client} {§operator-config-workspace-settings} plurnk-acp project-root confinement", { concurrency: true }, () => {
    for (const mode of ["unrestricted", "confined", "none"] as const) {
        test(`{§acp-daemon-client} {§operator-config-workspace-settings}: initialize advertises _meta.plurnk.policy (${mode}) and omits additionalDirectories under none`, async () => {
            const policy: ApplicationDaemonPolicy = {
                projectRoot: mode,
                ...(mode === "confined" ? {
                    mcp: { workspaceTransports: ["streamable-http"], publicOnly: true },
                    skills: { workspaceSources: ["mcp"], publicOnly: true },
                } : {}),
            };
            const h = await createHarness();
            h.port.daemonPolicy = () => policy;
            try {
                const stream = createWebSocketStream(h.wsUrl, { WebSocket: WsConstructor });
                const app = createRawAcpClient();
                await app.connectWith(stream, async (ctx) => {
                    const init = await ctx.request(methods.agent.initialize, {
                        protocolVersion: PROTOCOL_VERSION,
                        info: { name: "test-client", version: "1.0.0" },
                        capabilities: {},
                    });
                    const meta = (init._meta as { plurnk?: { policy?: ApplicationDaemonPolicy } } | undefined)?.plurnk;
                    assert.deepEqual(meta?.policy, policy);
                    if (mode === "none") {
                        assert.equal(init.capabilities?.session?.additionalDirectories, undefined);
                    } else {
                        assert.deepEqual(init.capabilities?.session?.additionalDirectories, {});
                    }
                });
            } finally {
                await h.close();
            }
        });
    }

    test("{§acp-daemon-client} {§operator-config-workspace-settings}: session/new refuses additionalDirectories under none and headless confined policies", async () => {
        const hNone = await createHarness();
        hNone.port.daemonPolicy = () => ({ projectRoot: "none" });
        try {
            const stream = createWebSocketStream(hNone.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/",
                        additionalDirectories: ["/etc"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type === "https://problems.plurnk.xyz/acp/project-root-forbidden";
                    },
                );
            });
        } finally {
            await hNone.close();
        }

        const hConfined = await createHarness();
        hConfined.port.daemonPolicy = () => ({ projectRoot: "confined" });
        const origInvoke = hConfined.port.invokeModuleAction.bind(hConfined.port);
        hConfined.port.invokeModuleAction = async (name, params, context) => {
            if (name === "workspace.members.add") {
                const problem = Problems.create("members:functionality", "members-confined", 403, "Confined to project root.");
                throw Object.assign(new Error(problem.detail), { problem });
            }
            return origInvoke(name, params, context);
        };
        try {
            const stream = createWebSocketStream(hConfined.wsUrl, { WebSocket: WsConstructor });
            const app = createAcpClient();
            await app.connectWith(stream, async (ctx) => {
                // Headless session under confined mode refuses additionalDirectories before invoking members.add.
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/",
                        additionalDirectories: ["/srv/tenants/other"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type?.endsWith("/members-confined") === true;
                    },
                );

                // Rooted session under confined mode propagates 403 members-confined from workspace.members.add.
                await assert.rejects(
                    () => ctx.request(methods.agent.session.new, {
                        cwd: "/srv/tenants/alice",
                        additionalDirectories: ["/srv/tenants/bob"],
                    }),
                    (err: unknown) => {
                        if (!(err instanceof RequestError)) return false;
                        const problem = (err.data as { problem?: { status?: number; type?: string } } | undefined)?.problem;
                        return err.code === -32000 && problem?.status === 403 && problem?.type?.endsWith("/members-confined") === true;
                    },
                );
            });
        } finally {
            await hConfined.close();
        }
    });
});
