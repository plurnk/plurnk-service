import test from "node:test";
import assert from "node:assert/strict";
import { aguiRouteTemplate } from "./observe.ts";

test("{§observability-boundary} AG-UI observation classifies routes without exporting input paths", () => {
    assert.equal(aguiRouteTemplate("POST", "/"), "unmatched");
    assert.equal(aguiRouteTemplate("POST", "/agui"), "/agui");
    assert.equal(aguiRouteTemplate("OPTIONS", "/secret-in-path?token=xyzzy"), "preflight");
    assert.equal(aguiRouteTemplate("GET", "/secret-in-path?token=xyzzy"), "unmatched");
    assert.equal(aguiRouteTemplate("GET", "/agui/3/77/entry?target=reasoning%3A%2F%2Fmain%2F1%2F2"), "/agui/{workspace}/{worker}/entry",
        "{§agui-entry-route} an address leaves the perimeter as its template, never the address itself");
    assert.equal(aguiRouteTemplate(undefined, undefined), "unmatched");
});
