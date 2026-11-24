import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import test from "node:test";
import { InFlightTracker, attachSseKeepAlive, writeHttpProblem, writeUpgradeProblem } from "./ApplicationPort.ts";
import Problems from "./Problems.ts";

test("{§http-admission} writeHttpProblem and writeUpgradeProblem serialize RFC 9457 Problem Details safely", () => {
    const problem = Problems.create("http", "route-not-found", 404, "Not found.");
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const res = {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        writeHead: (s: number, h: Record<string, string>) => {
            status = s;
            headers = h;
        },
        end: (b: string) => {
            body = b;
        },
    } as unknown as ServerResponse;

    writeHttpProblem(res, problem, { allow: "GET" });
    assert.equal(status, 404);
    assert.equal(headers["content-type"], "application/problem+json");
    assert.equal(headers.allow, "GET");
    assert.equal(JSON.parse(body).status, 404);

    // No-op when headers already sent
    let wroteAgain = false;
    writeHttpProblem(
        {
            headersSent: true,
            writableEnded: false,
            destroyed: false,
            writeHead: () => {
                wroteAgain = true;
            },
            end: () => {},
        } as unknown as ServerResponse,
        problem,
    );
    assert.equal(wroteAgain, false);

    let socketPayload = "";
    const socket = {
        writableEnded: false,
        destroyed: false,
        end: (chunk: string) => {
            socketPayload = chunk;
        },
    } as unknown as Duplex;
    writeUpgradeProblem(socket, problem, { "WWW-Authenticate": "Bearer" });
    assert.match(socketPayload, /^HTTP\/1\.1 404 Not Found\r\n/u);
    assert.match(socketPayload, /WWW-Authenticate: Bearer\r\n/u);
});

test("{§http-admission} attachSseKeepAlive and InFlightTracker manage SSE heartbeats and async settlement", async () => {
    let timeoutSet = -1;
    const writes: string[] = [];
    let closedCount = 0;

    const reqEmitter = new EventEmitter();
    Object.assign(reqEmitter, {
        socket: {
            setTimeout: (ms: number) => {
                timeoutSet = ms;
            },
        },
    });
    const resEmitter = new EventEmitter();
    Object.assign(resEmitter, {
        headersSent: true,
        writableEnded: false,
        destroyed: false,
        getHeader: () => "text/event-stream; charset=utf-8",
        write: (chunk: string) => {
            writes.push(chunk);
            return true;
        },
    });

    const stop = attachSseKeepAlive(
        reqEmitter as unknown as IncomingMessage,
        resEmitter as unknown as ServerResponse,
        {
            heartbeatMs: 10,
            requireEventStreamHeader: true,
            onClose: () => {
                closedCount += 1;
            },
        },
    );
    assert.equal(timeoutSet, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(writes.includes(": heartbeat\n\n"));
    stop();
    stop();
    assert.equal(closedCount, 1);

    const tracker = new InFlightTracker();
    const gate = Promise.withResolvers<string>();
    const tracked = tracker.track(gate.promise);
    assert.equal(tracker.size, 1);
    setTimeout(() => gate.resolve("done"), 5);
    await tracker.drain();
    assert.equal(await tracked, "done");
    assert.equal(tracker.size, 0);
});
