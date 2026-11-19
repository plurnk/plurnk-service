import assert from "node:assert/strict";
import test from "node:test";
import {
    toDaemonNotification,
    type ApplicationEventHandler,
    type CredentialAuthority,
    type DaemonNotification,
    type NotificationFilter,
    type NotificationReplayResult,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import HttpListener from "./HttpListener.ts";
import NotificationsEndpoint from "./NotificationsEndpoint.ts";

const makeCredentials = (oauth: boolean): CredentialAuthority => ({
    operatorSecret: null,
    issue: () => ({ token: "t", expiresAt: 0 }),
    verify: (token) => {
        if (token === "notifications-token") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["notifications"],
                family: "fam-notifications",
                expiresAt: 9_999_999_999_999,
            };
        }
        if (token === "acp-token") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["acp"],
                family: "fam-acp",
                expiresAt: 9_999_999_999_999,
            };
        }
        if (token === "mcp-only-token") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["mcp"],
                family: "fam-mcp",
                expiresAt: 9_999_999_999_999,
            };
        }
        return null;
    },
    consume: () => ({ reusedFamily: null }),
    revokeFamily: () => {},
    onRevoked: () => () => {},
    sessions: () => [],
    registerClient: (c) => ({ clientId: c.id, clientSecret: "secret" }),
    client: () => null,
    authenticateClient: () => false,
    publish: () => {},
    face: () => (oauth ? { issuer: () => "https://plurnk.example.com" } : null),
});

interface EndpointFixture {
    readonly port: number;
    readonly epoch: string;
    emit(notification: DaemonNotification): void;
    close(): Promise<void>;
}

const startEndpoint = async (options?: {
    oauth?: boolean;
    epoch?: string;
    replay?: (args: { lastEventId: string; filter?: NotificationFilter }) => NotificationReplayResult;
}): Promise<EndpointFixture> => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    const endpoint = new NotificationsEndpoint();
    const epoch = options?.epoch ?? "a1b2c3d4e5f60718";
    const handlers = new Set<{ handler: ApplicationEventHandler; filter?: NotificationFilter }>();
    const credentials = makeCredentials(options?.oauth ?? false);

    const seam = {
        credentials,
        notificationEpoch: epoch,
        registerHttpRoute: (prefix: string, handler: Parameters<HttpListener["registerHttpRoute"]>[1]) => {
            listener.registerHttpRoute(prefix, handler);
        },
        replayNotifications:
            options?.replay ??
            (({ lastEventId }) => ({
                status: "resync",
                resync: {
                    reason: lastEventId.includes(":") ? "restarted" : "malformed",
                    epoch,
                    latestId: 12,
                },
            })),
        subscribeToEvents: (handler: ApplicationEventHandler, filter?: NotificationFilter) => {
            const sub = { handler, filter };
            handlers.add(sub);
            return () => {
                handlers.delete(sub);
            };
        },
    } as unknown as ApplicationPort;

    endpoint.start(seam);
    listener.admit();

    return {
        port: listener.httpAddress().port,
        epoch,
        emit(notification) {
            for (const { handler } of handlers) {
                handler(notification.workspaceId, notification.event, notification.data, notification);
            }
        },
        async close() {
            endpoint.close();
            await listener.close();
        },
    };
};

test("{§notifications} {§http-host} notifications/resync stamps id: <epoch>:<latestId> so reconnecting EventSource cursors advance", async (t) => {
    const fx = await startEndpoint({ epoch: "0123456789abcdef" });
    t.after(() => fx.close());

    const controller = new AbortController();
    t.after(() => controller.abort());
    const res = await fetch(`http://127.0.0.1:${fx.port}/notifications`, {
        headers: {
            accept: "text/event-stream",
            "last-event-id": "deadbeefdeadbeef:42",
        },
        signal: controller.signal,
    });
    assert.equal(res.status, 200);

    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of res.body!) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes("event: notifications/resync") && text.endsWith("\n\n")) {
            break;
        }
    }
    controller.abort();

    const blocks = text.split("\n\n").filter((block) => block.length > 0 && !block.startsWith(":"));
    assert.equal(blocks.length, 1);
    const lines = blocks[0].split("\n");
    assert.equal(lines[0], "id: 0123456789abcdef:12");
    assert.equal(lines[1], "event: notifications/resync");
    assert.deepEqual(JSON.parse(lines[2].slice("data: ".length)), {
        reason: "restarted",
        epoch: "0123456789abcdef",
        latestId: 12,
    });

    // Live notifications also stamp `<epoch>:<id>`
    const liveAbort = new AbortController();
    t.after(() => liveAbort.abort());
    const liveRes = await fetch(`http://127.0.0.1:${fx.port}/notifications`, {
        headers: { accept: "text/event-stream" },
        signal: liveAbort.signal,
    });
    const liveNotification = toDaemonNotification(13, 1, "workspace/renamed", { id: 1, name: "alpha" });
    setImmediate(() => fx.emit(liveNotification));

    let liveText = "";
    for await (const chunk of liveRes.body!) {
        liveText += decoder.decode(chunk, { stream: true });
        if (liveText.includes("event: workspace/renamed")) break;
    }
    liveAbort.abort();
    assert.match(liveText, /id: 0123456789abcdef:13\nevent: workspace\/renamed\n/u);
});

test("{§notifications} {§credential-authority} {§http-host} /notifications admits notifications and acp scopes and challenges insufficient tokens with scope=\"notifications\"", async (t) => {
    const fx = await startEndpoint({ oauth: true });
    t.after(() => fx.close());
    const baseUrl = `http://127.0.0.1:${fx.port}/notifications`;

    const forbidden = await fetch(baseUrl, {
        headers: { authorization: "Bearer mcp-only-token" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(
        forbidden.headers.get("www-authenticate"),
        'Bearer realm="plurnk", error="insufficient_scope", scope="notifications", resource_metadata="https://plurnk.example.com/.well-known/oauth-protected-resource"',
    );
    const problem = (await forbidden.json()) as {
        code?: string;
        scope?: string;
        acceptedScopes?: string[];
        detail?: string;
        recovery?: string;
    };
    assert.equal(problem.code, "daemon/notifications/bearer-scope-insufficient");
    assert.equal(problem.scope, "notifications");
    assert.deepEqual(problem.acceptedScopes, ["notifications", "acp"]);
    assert.match(problem.detail ?? "", /notifications/u);
    assert.match(problem.recovery ?? "", /notifications/u);

    for (const token of ["notifications-token", "acp-token"]) {
        const okHead = await fetch(baseUrl, {
            method: "HEAD",
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(okHead.status, 200, `token ${token} is admitted`);
    }
});

test("{§notifications} {§http-host} PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN governs OPTIONS preflight and CORS headers", async (t) => {
    const priorOrigin = process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN;
    t.after(() => {
        if (priorOrigin === undefined) delete process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN;
        else process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN = priorOrigin;
    });

    const fx = await startEndpoint({ oauth: true });
    t.after(() => fx.close());
    const baseUrl = `http://127.0.0.1:${fx.port}/notifications`;

    // Default `*` answers OPTIONS 204 before bearer admission and attaches CORS headers
    delete process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN;
    process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN = "*";
    const preflight = await fetch(baseUrl, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Last-Event-ID");

    // Explicit origin is echoed on authenticated responses and 401 challenges alike
    process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN = "https://web.plurnk.example";
    const headRes = await fetch(baseUrl, {
        method: "HEAD",
        headers: { authorization: "Bearer notifications-token" },
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("access-control-allow-origin"), "https://web.plurnk.example");
    assert.equal(headRes.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(headRes.headers.get("access-control-allow-headers"), "Authorization, Last-Event-ID");

    const unauthRes = await fetch(baseUrl);
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.headers.get("access-control-allow-origin"), "https://web.plurnk.example");

    // Empty knob omits CORS headers while OPTIONS still answers 204
    process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN = "";
    const disabledPreflight = await fetch(baseUrl, { method: "OPTIONS" });
    assert.equal(disabledPreflight.status, 204);
    assert.equal(disabledPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(disabledPreflight.headers.get("access-control-allow-methods"), null);
    assert.equal(disabledPreflight.headers.get("access-control-allow-headers"), null);
});
