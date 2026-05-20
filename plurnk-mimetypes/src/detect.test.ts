import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detect, emptyRegistry } from "./detect.ts";
import type { Registry } from "./types.ts";

function registry(opts: {
    byExtension?: Record<string, string>;
    byFilename?: Record<string, string>;
}): Registry {
    return {
        byExtension: new Map(Object.entries(opts.byExtension ?? {})),
        byFilename: new Map(Object.entries(opts.byFilename ?? {})),
    };
}

describe("detect", () => {
    it("returns null when registry is empty and no hint provided", () => {
        assert.equal(detect({ path: "foo.js" }, emptyRegistry()), null);
    });

    it("returns null when no input fields are provided", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({}, reg), null);
    });

    it("hint wins over everything else", () => {
        const reg = registry({
            byExtension: { ".js": "text/javascript" },
            byFilename: { Dockerfile: "text/x-dockerfile" },
        });
        const result = detect(
            { path: "Dockerfile", ext: ".js", hint: "text/x-custom" },
            reg,
        );
        assert.equal(result, "text/x-custom");
    });

    it("matches by special filename (Dockerfile) when path's basename hits byFilename", () => {
        const reg = registry({
            byFilename: { Dockerfile: "text/x-dockerfile" },
            byExtension: { ".js": "text/javascript" },
        });
        assert.equal(detect({ path: "/foo/bar/Dockerfile" }, reg), "text/x-dockerfile");
    });

    it("filename match takes priority over extension when both could match", () => {
        const reg = registry({
            byFilename: { "Makefile.toml": "text/x-makefile" },
            byExtension: { ".toml": "application/toml" },
        });
        assert.equal(detect({ path: "Makefile.toml" }, reg), "text/x-makefile");
    });

    it("falls back to extension when filename doesn't match", () => {
        const reg = registry({
            byExtension: { ".py": "text/x-python" },
            byFilename: { Dockerfile: "text/x-dockerfile" },
        });
        assert.equal(detect({ path: "/src/main.py" }, reg), "text/x-python");
    });

    it("explicit ext beats path-derived ext", () => {
        const reg = registry({
            byExtension: {
                ".js": "text/javascript",
                ".ts": "text/typescript",
            },
        });
        assert.equal(
            detect({ path: "/src/main.js", ext: ".ts" }, reg),
            "text/typescript",
        );
    });

    it("normalizes extension case (matches .JS to .js registration)", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ ext: ".JS" }, reg), "text/javascript");
        assert.equal(detect({ path: "foo.JS" }, reg), "text/javascript");
    });

    it("normalizes extension to include leading dot", () => {
        const reg = registry({ byExtension: { ".py": "text/x-python" } });
        assert.equal(detect({ ext: "py" }, reg), "text/x-python");
        assert.equal(detect({ ext: "PY" }, reg), "text/x-python");
    });

    it("returns null for unknown extension", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "/src/main.unknown" }, reg), null);
    });

    it("returns null for path with no extension and no filename match", () => {
        const reg = registry({
            byExtension: { ".js": "text/javascript" },
            byFilename: { Dockerfile: "text/x-dockerfile" },
        });
        assert.equal(detect({ path: "/src/noext" }, reg), null);
    });

    it("ignores empty-string hint", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "foo.js", hint: "" }, reg), "text/javascript");
    });

    it("ignores empty-string path", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "", ext: ".js" }, reg), "text/javascript");
    });

    it("ignores empty-string ext", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "foo.js", ext: "" }, reg), "text/javascript");
    });

    it("content alone does not yet match (sniffing is a future hook)", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ content: "function foo() {}" }, reg), null);
    });
});

describe("emptyRegistry", () => {
    it("returns a registry with empty maps", () => {
        const reg = emptyRegistry();
        assert.equal(reg.byExtension.size, 0);
        assert.equal(reg.byFilename.size, 0);
    });
});
