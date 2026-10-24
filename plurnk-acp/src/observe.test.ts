import test from "node:test";
import assert from "node:assert/strict";
import { acpRouteTemplate } from "./observe.ts";

test("{§observability-boundary} ACP observation classifies routes without exporting input paths", () => {
    assert.equal(acpRouteTemplate("POST", "/"), "unmatched");
    assert.equal(acpRouteTemplate("POST", "/acp"), "/acp");
    assert.equal(acpRouteTemplate("OPTIONS", "/secret-in-path?token=xyzzy"), "preflight");
    assert.equal(acpRouteTemplate("GET", "/secret-in-path?token=xyzzy"), "unmatched");
    assert.equal(acpRouteTemplate("GET", "/acp/3/77/entry?target=reasoning%3A%2F%2Fmain%2F1%2F2"), "/acp/{workspace}/{worker}/entry",
        "{§acp-entry-route} an address leaves the perimeter as its template, never the address itself");
    assert.equal(acpRouteTemplate(undefined, undefined), "unmatched");
});
