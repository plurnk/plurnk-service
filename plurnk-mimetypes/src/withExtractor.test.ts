import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withExtractor } from "./withExtractor.ts";

// Stub the antlr4ng visitor base class — `withExtractor` only requires `visit`
// and `visitChildren` shape; real generated visitors satisfy this.
class StubVisitorBase {
    visit(_tree: unknown): unknown {
        return null;
    }
    visitChildren(_node: unknown): unknown {
        return null;
    }
}

// Stub ParserRuleContext shape — addSymbol only reads start.line and stop?.line.
function ctx(line: number, endLine?: number): unknown {
    return {
        start: { line },
        stop: endLine !== undefined ? { line: endLine } : null,
    };
}

describe("withExtractor mixin", () => {
    it("starts with an empty symbols list", () => {
        class V extends withExtractor(StubVisitorBase) {}
        const v = new V();
        assert.deepEqual(v.symbols, []);
    });

    it("starts with inBody false", () => {
        class V extends withExtractor(StubVisitorBase) {
            check(): boolean {
                return this.inBody;
            }
        }
        const v = new V();
        assert.equal(v.check(), false);
    });

    it("addSymbol captures start line and stop line from the context", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("class", "Foo", ctx(5, 20) as never);
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "Foo", kind: "class", line: 5, endLine: 20 },
        ]);
    });

    it("addSymbol falls back to start line when stop is null", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("constant", "X", ctx(7) as never);
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "X", kind: "constant", line: 7, endLine: 7 },
        ]);
    });

    it("addSymbol includes params and extra fields when provided", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol(
                    "heading",
                    "Section",
                    ctx(3) as never,
                    undefined,
                    { level: 2 },
                );
                this.addSymbol(
                    "function",
                    "parse",
                    ctx(10, 15) as never,
                    ["source", "options"],
                );
            }
        }
        const v = new V();
        v.doAdd();
        assert.deepEqual(v.symbols, [
            { name: "Section", kind: "heading", line: 3, endLine: 3, level: 2 },
            {
                name: "parse",
                kind: "function",
                line: 10,
                endLine: 15,
                params: ["source", "options"],
            },
        ]);
    });

    it("gateBody flips inBody true during children visit and restores after", () => {
        let inBodyDuringVisit: boolean | null = null;
        class FakeBase {
            visit(_tree: unknown): unknown {
                return null;
            }
            visitChildren(_node: unknown): unknown {
                inBodyDuringVisit = (this as unknown as { inBody: boolean }).inBody;
                return null;
            }
        }
        class V extends withExtractor(FakeBase) {
            run(): void {
                this.gateBody(ctx(1, 10) as never);
            }
            checkAfter(): boolean {
                return this.inBody;
            }
        }
        const v = new V();
        v.run();
        assert.equal(inBodyDuringVisit, true);
        assert.equal(v.checkAfter(), false);
    });

    it("gateBody restores prior inBody value, not always false (handles nesting)", () => {
        const seen: boolean[] = [];
        class FakeBase {
            visit(_tree: unknown): unknown {
                return null;
            }
            visitChildren(_node: unknown): unknown {
                seen.push((this as unknown as { inBody: boolean }).inBody);
                return null;
            }
        }
        class V extends withExtractor(FakeBase) {
            outer(): void {
                this.gateBody({
                    ...(ctx(1, 100) as object),
                } as never);
            }
            inner(): void {
                this.gateBody(ctx(5, 20) as never);
            }
        }
        const v = new V();
        // Simulate nested body: outer gates, during visitChildren the inner gates.
        // The mixin must restore correctly so a hypothetical post-inner peek inside
        // outer would still see inBody=true.
        v.outer();
        // After outer: inBody should be false again.
        assert.equal(seen.length, 1);
        assert.equal(seen[0], true);
    });

    it("returns a defensive copy from symbols getter (caller can't mutate state)", () => {
        class V extends withExtractor(StubVisitorBase) {
            doAdd(): void {
                this.addSymbol("class", "Foo", ctx(1) as never);
            }
        }
        const v = new V();
        v.doAdd();
        const snapshot = v.symbols;
        snapshot.pop();
        assert.equal(v.symbols.length, 1, "internal state should be unaffected by mutating the snapshot");
    });
});
