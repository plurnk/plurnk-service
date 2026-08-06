import test from "node:test";
import assert from "node:assert/strict";
import { aguiRouteTemplate } from "./observe.ts";

test("AG-UI observation classifies routes without exporting input paths", () => {
    assert.equal(aguiRouteTemplate("POST", "/"), "/agui");
    assert.equal(aguiRouteTemplate("POST", "/agui"), "/agui");
    assert.equal(aguiRouteTemplate("OPTIONS", "/secret-in-path?token=xyzzy"), "preflight");
    assert.equal(aguiRouteTemplate("GET", "/secret-in-path?token=xyzzy"), "unmatched");
    assert.equal(aguiRouteTemplate(undefined, undefined), "unmatched");
});
