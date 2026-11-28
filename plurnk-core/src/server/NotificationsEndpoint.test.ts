import assert from "node:assert/strict";
import test from "node:test";
import {
    Validator,
    toDaemonNotification,
    type ApplicationEventHandler,
    type ApplicationSessionOverview,
    type CredentialAuthority,
    type DaemonNotification,
    type NotificationFilter,
    type NotificationReplayResult,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import HttpListener from "./HttpListener.ts";
import NotificationsEndpoint from "./NotificationsEndpoint.ts";

const makeCredentials = (oauth: boolean): CredentialAuthority => {
    const verify = async (token: string) => {
        if (token === "notifications-token" || token === "acp-token") {
            return {
                subject: "operator",
                scopes: ["openid"],
                expiresAt: 9_999_999_999_999,
            };
        }
        return null;
    };
    return {
        verify: (token) => (oauth ? verify(token) : null),
        publish: () => {},
        face: () => (oauth ? { issuer: () => "https://plurnk.example.com", verify } : null),
    };
};

interface EndpointFixture {
    readonly port: number;
    readonly epoch: string;
    emit(notification: DaemonNotification): void;
    close(): Promise<void>;
}

const startEndpoint = async (options?: {
    oauth?: boolean;
    epoch?: string;
    latestId?: number;
    overview?: ApplicationSessionOverview;
    replay?: (args: { lastEventId: string; filter?: NotificationFilter }) => NotificationReplayResult;
}): Promise<EndpointFixture> => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    const endpoint = new NotificationsEndpoint();
    const epoch = options?.epoch ?? "a1b2c3d4e5f60718";
    let latestId = options?.latestId ?? 12;
    const handlers = new Set<{ handler: ApplicationEventHandler; filter?: NotificationFilter }>();
    const credentials = makeCredentials(options?.oauth ?? false);

    const seam = {
        credentials,
        httpAddress: () => listener.httpAddress(),
        notificationEpoch: epoch,
        get notificationLatestId() {
            return latestId;
        },
        registerHttpRoute: (prefix: string, handler: Parameters<HttpListener["registerHttpRoute"]>[1]) => {
            listener.registerHttpRoute(prefix, handler);
        },
        readSessionOverview: async () =>
            options?.overview ?? {
                sessions: [],
                workspaces: [{ id: 1, name: "alpha", projectRoot: null, projectLabel: null }],
                proposals: [],
                interactions: [],
                omitted: 0,
            },
        replayNotifications:
            options?.replay ??
            (({ lastEventId }) => ({
                status: "resync",
                resync: {
                    reason: lastEventId.includes(":") ? "restarted" : "malformed",
                    epoch,
                    latestId,
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
            latestId = Math.max(latestId, notification.id);
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

test("{§notifications} {§http-host} Watch-by-default emits schema-valid notifications/snapshot on cold start and out-of-window Last-Event-ID while ?since=now emits notifications/resync", async (t) => {
    const fx = await startEndpoint({ epoch: "0123456789abcdef", latestId: 12 });
    t.after(() => fx.close());
    const decoder = new TextDecoder();

    // 1. Out-of-window Last-Event-ID in default Watch mode self-heals with notifications/snapshot(restarted)
    const watchController = new AbortController();
    t.after(() => watchController.abort());
    const watchRes = await fetch(`http://127.0.0.1:${fx.port}/notifications`, {
        headers: {
            accept: "text/event-stream",
            "last-event-id": "deadbeefdeadbeef:42",
        },
        signal: watchController.signal,
    });
    assert.equal(watchRes.status, 200);

    let watchText = "";
    for await (const chunk of watchRes.body!) {
        watchText += decoder.decode(chunk, { stream: true });
        if (watchText.includes("event: notifications/snapshot") && watchText.endsWith("\n\n")) {
            break;
        }
    }
    watchController.abort();

    const watchBlocks = watchText.split("\n\n").filter((block) => block.length > 0 && !block.startsWith(":"));
    assert.equal(watchBlocks.length, 1);
    const watchLines = watchBlocks[0].split("\n");
    assert.equal(watchLines[0], "id: 0123456789abcdef:12");
    assert.equal(watchLines[1], "event: notifications/snapshot");
    const snapshotEnv = Validator.assertDaemonNotification(JSON.parse(watchLines[2].slice("data: ".length)));
    assert.equal(snapshotEnv.event, "notifications/snapshot");
    assert.equal(snapshotEnv.id, 12);
    assert.equal(snapshotEnv.data.reason, "restarted");
    assert.equal(snapshotEnv.data.epoch, "0123456789abcdef");
    assert.equal(snapshotEnv.data.latestId, 12);
    assert.equal(snapshotEnv.data.workspaces.length, 1);

    // 2. ?since=now opts into tail-only streaming and emits schema-valid notifications/resync Envelope on out-of-window Last-Event-ID
    const tailController = new AbortController();
    t.after(() => tailController.abort());
    const tailRes = await fetch(`http://127.0.0.1:${fx.port}/notifications?since=now`, {
        headers: {
            accept: "text/event-stream",
            "last-event-id": "deadbeefdeadbeef:42",
        },
        signal: tailController.signal,
    });
    assert.equal(tailRes.status, 200);

    let tailText = "";
    for await (const chunk of tailRes.body!) {
        tailText += decoder.decode(chunk, { stream: true });
        if (tailText.includes("event: notifications/resync") && tailText.endsWith("\n\n")) {
            break;
        }
    }
    tailController.abort();

    const tailBlocks = tailText.split("\n\n").filter((block) => block.length > 0 && !block.startsWith(":"));
    assert.equal(tailBlocks.length, 1);
    const tailLines = tailBlocks[0].split("\n");
    assert.equal(tailLines[0], "id: 0123456789abcdef:12");
    assert.equal(tailLines[1], "event: notifications/resync");
    const resyncEnv = Validator.assertDaemonNotification(JSON.parse(tailLines[2].slice("data: ".length)));
    assert.equal(resyncEnv.event, "notifications/resync");
    assert.deepEqual(resyncEnv.data, {
        reason: "restarted",
        epoch: "0123456789abcdef",
        latestId: 12,
    });

    // 3. Invalid `since` values reject 400 daemon/notifications/invalid-filter
    const badSince = await fetch(`http://127.0.0.1:${fx.port}/notifications?since=0`);
    assert.equal(badSince.status, 400);
    assert.equal(((await badSince.json()) as { code?: string }).code, "daemon/notifications/invalid-filter");

    // 4. Cold connect emits initial notifications/snapshot then live notifications stamped `<epoch>:<id>`
    const liveAbort = new AbortController();
    t.after(() => liveAbort.abort());
    const liveRes = await fetch(`http://127.0.0.1:${fx.port}/notifications`, {
        headers: { accept: "text/event-stream" },
        signal: liveAbort.signal,
    });
    let liveText = "";
    let emitted = false;
    for await (const chunk of liveRes.body!) {
        liveText += decoder.decode(chunk, { stream: true });
        if (!emitted && liveText.includes("event: notifications/snapshot")) {
            emitted = true;
            fx.emit(toDaemonNotification(13, 1, "workspace/renamed", { id: 1, name: "alpha-v2" }));
        }
        if (liveText.includes("event: workspace/renamed")) break;
    }
    liveAbort.abort();
    assert.match(liveText, /id: 0123456789abcdef:12\nevent: notifications\/snapshot\n/u);
    assert.match(liveText, /id: 0123456789abcdef:13\nevent: workspace\/renamed\n/u);
});

test("{§notifications} {§credential-authority} {§http-host} /notifications enforces bearer tokens, query tokens, and browser origin CSRF protection", async (t) => {
    const fx = await startEndpoint({ oauth: true });
    t.after(() => fx.close());
    const baseUrl = `http://127.0.0.1:${fx.port}/notifications`;

    const missing = await fetch(baseUrl);
    assert.equal(missing.status, 401);
    assert.equal(
        missing.headers.get("www-authenticate"),
        'Bearer realm="plurnk", resource_metadata="https://plurnk.example.com/.well-known/oauth-protected-resource"',
    );

    const invalid = await fetch(baseUrl, {
        headers: { authorization: "Bearer invalid-token" },
    });
    assert.equal(invalid.status, 401);
    const problem = (await invalid.json()) as { code?: string };
    assert.equal(problem.code, "daemon/notifications/bearer-token-invalid");

    const crossSite = await fetch(baseUrl, {
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(((await crossSite.json()) as { code?: string }).code, "daemon/notifications/cross-origin-forbidden");

    for (const token of ["notifications-token", "acp-token"]) {
        const okHead = await fetch(baseUrl, {
            method: "HEAD",
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(okHead.status, 200, `token ${token} is admitted`);
    }

    const okQuery = await fetch(`${baseUrl}?access_token=acp-token`, { method: "HEAD" });
    assert.equal(okQuery.status, 200);
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

    // Default empty knob omits CORS headers while OPTIONS still answers 204 before bearer admission
    delete process.env.PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN;
    const defaultPreflight = await fetch(baseUrl, { method: "OPTIONS" });
    assert.equal(defaultPreflight.status, 204);
    assert.equal(defaultPreflight.headers.get("access-control-allow-origin"), null);

    // Explicit `*` answers OPTIONS 204 before bearer admission and attaches CORS headers
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
