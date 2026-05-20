import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
    mimetypeToClassName,
    mimetypeToSafeName,
    runInit,
} from "./init.ts";

describe("mimetypeToSafeName", () => {
    it("converts text/plain to text-plain", () => {
        assert.equal(mimetypeToSafeName("text/plain"), "text-plain");
    });

    it("converts text/x-python to text-x-python", () => {
        assert.equal(mimetypeToSafeName("text/x-python"), "text-x-python");
    });

    it("converts application/json to application-json", () => {
        assert.equal(mimetypeToSafeName("application/json"), "application-json");
    });

    it("converts image/svg+xml to image-svg-xml", () => {
        assert.equal(mimetypeToSafeName("image/svg+xml"), "image-svg-xml");
    });
});

describe("mimetypeToClassName", () => {
    it("converts text/plain to TextPlain", () => {
        assert.equal(mimetypeToClassName("text/plain"), "TextPlain");
    });

    it("converts text/x-python to TextXPython", () => {
        assert.equal(mimetypeToClassName("text/x-python"), "TextXPython");
    });

    it("converts application/json to ApplicationJson", () => {
        assert.equal(mimetypeToClassName("application/json"), "ApplicationJson");
    });

    it("converts image/svg+xml to ImageSvgXml", () => {
        assert.equal(mimetypeToClassName("image/svg+xml"), "ImageSvgXml");
    });
});

describe("runInit", () => {
    let tmp: string;

    before(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-init-"));
    });

    after(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it("scaffolds expected files for a basic handler", async () => {
        const out = path.join(tmp, "basic");
        const result = await runInit({
            mimetype: "text/plain",
            out,
            glyph: "📄",
            extensions: [".txt"],
            version: "^0.1.0",
        });

        assert.equal(result.outDir, out);
        // Renamed Handler.ts/Handler.test.ts → TextPlain.{ts,test.ts}.
        assert.ok(result.files.includes("package.json"));
        assert.ok(result.files.includes("AGENTS.md"));
        assert.ok(result.files.includes("tsconfig.json"));
        assert.ok(result.files.includes("tsconfig.build.json"));
        assert.ok(result.files.includes(".gitignore"));
        assert.ok(!result.files.includes("_gitignore"), "template _gitignore should be renamed to .gitignore");
        assert.ok(result.files.includes("README.md"));
        assert.ok(result.files.includes("src/TextPlain.ts"));
        assert.ok(result.files.includes("src/TextPlain.test.ts"));
        // Handler.ts shouldn't survive as-is.
        assert.ok(!result.files.includes("src/Handler.ts"));
    });

    it("substitutes placeholders in package.json", async () => {
        const out = path.join(tmp, "pkg-subs");
        await runInit({
            mimetype: "text/x-python",
            out,
            glyph: "🐍",
            extensions: [".py", ".pyw"],
            version: "^0.1.0",
        });

        const pkg = JSON.parse(
            await fs.readFile(path.join(out, "package.json"), "utf-8"),
        ) as {
            name: string;
            description: string;
            plurnk: { name: string; glyph: string; extensions: string[] };
            dependencies: Record<string, string>;
        };
        assert.equal(pkg.name, "@plurnk/plurnk-mimetypes-text-x-python");
        assert.equal(pkg.description, "text/x-python mimetype handler for plurnk-service.");
        assert.equal(pkg.plurnk.name, "text/x-python");
        assert.equal(pkg.plurnk.glyph, "🐍");
        assert.deepEqual(pkg.plurnk.extensions, [".py", ".pyw"]);
        assert.equal(pkg.dependencies["@plurnk/plurnk-mimetypes"], "^0.1.0");
    });

    it("substitutes placeholders in source file", async () => {
        const out = path.join(tmp, "src-subs");
        await runInit({
            mimetype: "application/json",
            out,
            glyph: "📋",
            extensions: [".json"],
            version: "^0.1.0",
        });

        const src = await fs.readFile(path.join(out, "src", "ApplicationJson.ts"), "utf-8");
        assert.ok(src.includes("export default class ApplicationJson extends BaseHandler"));
        assert.ok(src.includes("application/json"), "mimetype should appear in source");
        assert.ok(!src.includes("{{"), "no unsubstituted placeholders should remain");
    });

    it("substitutes placeholders in test file and imports the renamed class", async () => {
        const out = path.join(tmp, "test-subs");
        await runInit({
            mimetype: "text/markdown",
            out,
            glyph: "📝",
            extensions: [".md"],
            version: "^0.1.0",
        });

        const test = await fs.readFile(path.join(out, "src", "TextMarkdown.test.ts"), "utf-8");
        assert.ok(test.includes('import TextMarkdown from "./TextMarkdown.ts"'));
        assert.ok(test.includes('mimetype: "text/markdown"'));
        assert.ok(test.includes('glyph: "📝"'));
    });

    it("emits a gitignored AGENTS.md (.gitignore contains 'AGENTS.md')", async () => {
        const out = path.join(tmp, "ignore-check");
        await runInit({
            mimetype: "text/plain",
            out,
            glyph: "📄",
            extensions: [".txt"],
            version: "^0.1.0",
        });

        const gitignore = await fs.readFile(path.join(out, ".gitignore"), "utf-8");
        assert.ok(/^AGENTS\.md$/m.test(gitignore));
    });

    it("refuses to overwrite an existing directory", async () => {
        const out = path.join(tmp, "overwrite");
        await fs.mkdir(out);
        await assert.rejects(
            () => runInit({
                mimetype: "text/plain",
                out,
                glyph: "📄",
                extensions: [".txt"],
                version: "^0.1.0",
            }),
            /Refusing to overwrite/,
        );
    });
});
