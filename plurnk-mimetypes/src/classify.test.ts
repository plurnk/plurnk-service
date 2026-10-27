import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "./Mimetypes.ts";
import { classifyMimetype } from "./classify.ts";
import type { Discovery, HandlerInfo, Registry } from "./types.ts";
import { detect, emptyRegistry } from "./detect.ts";

// ─── classify.test.ts ───
{
// Contract: {§mimetype-content}.






function mk(handlers: HandlerInfo[]): Mimetypes {
    const registry: Registry = { byExtension: new Map(), byFilename: new Map() };
    return new Mimetypes({
        discovery: { registry, handlers: new Map(handlers.map((h) => [h.mimetype, h])), packageAttributions: new Map(), skipped: [] } satisfies Discovery,
        loader: async () => ({}),
    });
}

const info = (mimetype: string, extra: Partial<HandlerInfo> = {}): HandlerInfo => ({
    mimetype,
    glyph: "",
    packageName: `@plurnk/plurnk-mimetypes-test`,
    projectionRevision: "test-1",
    extensions: [],
    binary: false,
    source: "package",
    ...extra,
});

describe("{§mimetype-content} binary axis (taxonomy heuristic)", () => {
    const text = [
        "text/plain", "text/markdown", "text/html", "text/csv",
        "application/json", "application/yaml", "application/toml", "application/xml",
        "application/jsonl", "application/x-ndjson",
        "application/vnd.api+json", "image/svg+xml", "application/cloudevents+yaml",
    ];
    const binary = [
        "image/png", "image/jpeg", "audio/mpeg", "video/mp4",
        "application/pdf", "application/octet-stream", "application/zip",
        "noslashhere", // malformed -> binary -> consumers 415
    ];
    for (const mt of text) {
        it(`{§mimetype-content} ${mt} is text`, () => assert.equal(classifyMimetype(mt).binary, false));
    }
    for (const mt of binary) {
        it(`{§mimetype-content} ${mt} is binary`, () => assert.equal(classifyMimetype(mt).binary, true));
    }
    it("{§mimetype-content} empty string is not binary", () => {
        assert.deepEqual(classifyMimetype(""), { binary: false, source: "heuristic" });
    });
});

describe("{§mimetype-content} an installed handler's binary declaration wins", () => {
    it("{§mimetype-content} declared binary (pdf) is authoritative, source: handler", async () => {
        const m = mk([info("application/pdf", { binary: true })]);
        assert.deepEqual(await m.classify("application/pdf"), { binary: true, source: "handler" });
    });
    it("{§mimetype-content} an installed text handler overrides a binary heuristic", async () => {
        const m = mk([info("application/x-treeish")]);
        assert.deepEqual(await m.classify("application/x-treeish"), { binary: false, source: "handler" });
    });
});

describe("{§mimetype-content} unregistered mimetypes still classify", () => {
    it("{§mimetype-content} a stream label with no installed handler gets the heuristic answer", async () => {
        const m = mk([]);
        assert.deepEqual(await m.classify("application/x-ndjson"), { binary: false, source: "heuristic" });
        assert.deepEqual(await m.classify("image/png"), { binary: true, source: "heuristic" });
    });
});
}

// ─── detect.test.ts ───
{
// Contract: {§treesitter-runtime-gate}.




function registry(opts: {
    byExtension?: Record<string, string>;
    byFilename?: Record<string, string>;
}): Registry {
    return {
        byExtension: new Map(Object.entries(opts.byExtension ?? {})),
        byFilename: new Map(Object.entries(opts.byFilename ?? {})),
    };
}

describe("{§treesitter-runtime-gate} detect", () => {
    it("{§treesitter-runtime-gate} returns null when registry is empty and no hint provided", () => {
        assert.equal(detect({ path: "foo.js" }, emptyRegistry()), null);
    });

    it("{§treesitter-runtime-gate} returns null when no input fields are provided", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({}, reg), null);
    });

    it("{§treesitter-runtime-gate} hint wins over everything else", () => {
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

    it("{§treesitter-runtime-gate} matches by special filename (Dockerfile) when path's basename hits byFilename", () => {
        const reg = registry({
            byFilename: { Dockerfile: "text/x-dockerfile" },
            byExtension: { ".js": "text/javascript" },
        });
        assert.equal(detect({ path: "/foo/bar/Dockerfile" }, reg), "text/x-dockerfile");
    });

    it("{§treesitter-runtime-gate} resolves a bare dotfile (.env) via the byExtension full-name fallback", () => {
        // discover() files `.`-prefixed declarations under byExtension, and a
        // file literally named `.env` has no extname() — the fallback matches
        // the whole basename. Also covers the latent `.bashrc`/`.zshrc` case.
        const reg = registry({ byExtension: { ".env": "text/x-dotenv", ".bashrc": "text/x-shellscript" } });
        assert.equal(detect({ path: "project/.env" }, reg), "text/x-dotenv");
        assert.equal(detect({ path: ".bashrc" }, reg), "text/x-shellscript");
    });

    it("{§treesitter-runtime-gate} a real extension still wins over the dotfile fallback (foo.env)", () => {
        const reg = registry({ byExtension: { ".env": "text/x-dotenv" } });
        assert.equal(detect({ path: "foo.env" }, reg), "text/x-dotenv");
    });

    it("{§treesitter-runtime-gate} filename match takes priority over extension when both could match", () => {
        const reg = registry({
            byFilename: { "Makefile.toml": "text/x-makefile" },
            byExtension: { ".toml": "application/toml" },
        });
        assert.equal(detect({ path: "Makefile.toml" }, reg), "text/x-makefile");
    });

    it("{§treesitter-runtime-gate} falls back to extension when filename doesn't match", () => {
        const reg = registry({
            byExtension: { ".py": "text/x-python" },
            byFilename: { Dockerfile: "text/x-dockerfile" },
        });
        assert.equal(detect({ path: "/src/main.py" }, reg), "text/x-python");
    });

    it("{§treesitter-runtime-gate} explicit ext beats path-derived ext", () => {
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

    it("{§treesitter-runtime-gate} normalizes extension case (matches .JS to .js registration)", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ ext: ".JS" }, reg), "text/javascript");
        assert.equal(detect({ path: "foo.JS" }, reg), "text/javascript");
    });

    it("{§treesitter-runtime-gate} normalizes extension to include leading dot", () => {
        const reg = registry({ byExtension: { ".py": "text/x-python" } });
        assert.equal(detect({ ext: "py" }, reg), "text/x-python");
        assert.equal(detect({ ext: "PY" }, reg), "text/x-python");
    });

    it("{§treesitter-runtime-gate} returns null for unknown extension", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "/src/main.unknown" }, reg), null);
    });

    it("{§treesitter-runtime-gate} returns null for path with no extension and no filename match", () => {
        const reg = registry({
            byExtension: { ".js": "text/javascript" },
            byFilename: { Dockerfile: "text/x-dockerfile" },
        });
        assert.equal(detect({ path: "/src/noext" }, reg), null);
    });

    it("{§treesitter-runtime-gate} ignores empty-string hint", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "foo.js", hint: "" }, reg), "text/javascript");
    });

    it("{§treesitter-runtime-gate} ignores empty-string path", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "", ext: ".js" }, reg), "text/javascript");
    });

    it("{§treesitter-runtime-gate} ignores empty-string ext", () => {
        const reg = registry({ byExtension: { ".js": "text/javascript" } });
        assert.equal(detect({ path: "foo.js", ext: "" }, reg), "text/javascript");
    });

});

describe("{§treesitter-runtime-gate} emptyRegistry", () => {
    it("{§treesitter-runtime-gate} returns a registry with empty maps", () => {
        const reg = emptyRegistry();
        assert.equal(reg.byExtension.size, 0);
        assert.equal(reg.byFilename.size, 0);
    });
});
}
