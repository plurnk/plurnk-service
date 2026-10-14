import assert from "node:assert/strict";
import test from "node:test";
import { requestOrigin } from "./index.ts";

test("{§http-request-origin} a request's origin is the address its Host names, over http, else the listener's own", () => {
    const listener = { host: "0.0.0.0", port: 1066 };
    for (const [named, origin] of [
        ["192.168.1.88:1066", "http://192.168.1.88:1066"],
        ["desktop.lan:1066", "http://desktop.lan:1066"],
        ["[fe80::1]:1066", "http://[fe80::1]:1066"],
        ["localhost", "http://localhost"],
    ] as const) assert.equal(requestOrigin({ headers: { host: named } }, listener), origin, named);
    assert.equal(requestOrigin({ headers: {} }, listener), "http://0.0.0.0:1066", "a request that names no address is answered at the listener's");
    assert.equal(requestOrigin({ headers: {} }, { host: "::1", port: 1066 }), "http://[::1]:1066");
});
