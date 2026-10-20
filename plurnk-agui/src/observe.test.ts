import test from "node:test";
import assert from "node:assert/strict";
import { aguiRouteTemplate } from "./observe.ts";

test("{§observability-boundary} AG-UI observation classifies routes without exporting input paths", () => {
    assert.equal(aguiRouteTemplate("POST", "/"), "unmatched");
    assert.equal(aguiRouteTemplate("POST", "/agui"), "/agui");
    assert.equal(aguiRouteTemplate("OPTIONS", "/secret-in-path?token=xyzzy"), "preflight");
    assert.equal(aguiRouteTemplate("GET", "/secret-in-path?token=xyzzy"), "unmatched");
    assert.equal(aguiRouteTemplate("GET", "/agui/3/77/log/1/2/3/READ"), "/agui/{workspace}/{worker}/log/{loop}/{turn}/{sequence}/{op}",
        "{§agui-body-reference} a body's address leaves the perimeter as its template");
    assert.equal(aguiRouteTemplate(undefined, undefined), "unmatched");
});
