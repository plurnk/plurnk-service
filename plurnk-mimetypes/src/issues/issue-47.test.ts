// Coverage: SPEC §21 (embedding-eligibility suppression).
// Issue #47 (service#337): derivation-eligibility via PLURNK_MIMETYPES_NO_EMBED
// — the operator's pattern list IS the classification (owner paradigm: the
// decision table lives in .env.example, no code fallback, no hidden heuristic).
//
//   N1. pattern semantics: globs, exact basenames, first-match reason.
//   N2. NO code fallback: knob unset → nothing suppressed, even package-lock.
//   N3. the shipped .env.defaults default catches the service#337 offenders and
//       spares legitimate long content (novel, JSONL, wide CSV).
//   N4. surfaced on process(): present iff matched, absent otherwise.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import { matchNoEmbed } from "../noEmbed.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const DEFAULT_LIST = readFileSync(new URL("../../.env.defaults", import.meta.url), "utf-8")
    .split("\n").find((l) => l.startsWith("PLURNK_MIMETYPES_NO_EMBED="))!
    .slice("PLURNK_MIMETYPES_NO_EMBED=".length);

// Async on purpose: a sync try/finally would restore the env BEFORE an awaited
// process() inside fn ever reads it.
async function withKnob<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
    const prev = process.env.PLURNK_MIMETYPES_NO_EMBED;
    if (value === undefined) delete process.env.PLURNK_MIMETYPES_NO_EMBED;
    else process.env.PLURNK_MIMETYPES_NO_EMBED = value;
    try { return await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_MIMETYPES_NO_EMBED;
        else process.env.PLURNK_MIMETYPES_NO_EMBED = prev;
    }
}

const INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt", ".js", ".json"],
    binary: false,
    source: "package",
};

function mk(): Mimetypes {
    const registry: Registry = {
        byExtension: new Map([[".txt", "text/plain"], [".js", "text/plain"], [".json", "text/plain"]]),
        byFilename: new Map(),
    };
    return new Mimetypes({
        discovery: { registry, handlers: new Map([["text/plain", INFO]]) } satisfies Discovery,
        loader: async () => ({ default: BaseHandler }),
    });
}

describe("Issue #47 — N1: pattern semantics", () => {
    it("glob entries match basenames; the matched pattern is the reason", async () => {
        await withKnob("*.min.*, *.map", () => {
            assert.equal(matchNoEmbed("/dist/app.min.js"), "*.min.*");
            assert.equal(matchNoEmbed("/dist/bundle.js.map"), "*.map");
            assert.equal(matchNoEmbed("/src/index.js"), undefined);
        });
    });
    it("no-star entries are exact basename matches, not substrings", async () => {
        await withKnob("go.sum", () => {
            assert.equal(matchNoEmbed("/x/go.sum"), "go.sum");
            assert.equal(matchNoEmbed("/x/logo.sum"), undefined, "no substring matching");
            assert.equal(matchNoEmbed("/x/go.summary"), undefined);
        });
    });
    it("no path → no signal", async () => {
        await withKnob("*.min.*", () => assert.equal(matchNoEmbed(undefined), undefined));
    });
});

describe("Issue #47 — N2: no code fallback, ever", () => {
    it("knob unset → NOTHING suppressed, even package-lock.json", async () => {
        await withKnob(undefined, () => assert.equal(matchNoEmbed("/x/package-lock.json"), undefined));
    });
    it("knob empty → nothing suppressed", async () => {
        await withKnob("  ", () => assert.equal(matchNoEmbed("/x/package-lock.json"), undefined));
    });
});

describe("Issue #47 — N3: the shipped default list", () => {
    it("catches the service#337 offenders", async () => {
        await withKnob(DEFAULT_LIST, () => {
            assert.equal(matchNoEmbed("/repo/package-lock.json"), "package-lock.json");
            assert.equal(matchNoEmbed("/docs/assets/app.5c2f.min.js"), "*.min.*");
            assert.equal(matchNoEmbed("/dist/main.js.map"), "*.map");
            assert.equal(matchNoEmbed("/api/Cargo.lock"), "Cargo.lock");
        });
    });
    it("carries the #339-ruled drawers (#53): the run20-class specimens", async () => {
        await withKnob(DEFAULT_LIST, () => {
            assert.equal(matchNoEmbed("/coverage/lcov-report/index.html"), "*/coverage/*", "leading / satisfies the */ form (empty prefix)");
            assert.equal(matchNoEmbed("coverage/lcov-report/index.html"), "coverage/*", "relative root form");
            assert.equal(matchNoEmbed("/repo/coverage/lcov-report/index.html"), "*/coverage/*");
            assert.equal(matchNoEmbed("/repo/vendor/lib/min.js"), "*/vendor/*");
            assert.equal(matchNoEmbed("/docs/.vuepress/cache/x.js"), "*/.vuepress/*");
            assert.equal(matchNoEmbed("/app/.nuxt/dist-thing.js"), "*/.nuxt/*");
            assert.equal(matchNoEmbed("/src/vendors-list.md"), undefined, "vendor inside a name is not the drawer");
        });
    });
    it("spares legitimate long content — the novel, JSONL, wide CSV", async () => {
        await withKnob(DEFAULT_LIST, () => {
            assert.equal(matchNoEmbed("/books/novel.md"), undefined);
            assert.equal(matchNoEmbed("/data/records.jsonl"), undefined);
            assert.equal(matchNoEmbed("/data/wide.csv"), undefined);
            assert.equal(matchNoEmbed("/src/minified-parser.ts"), undefined, "'min' inside a name is not *.min.*");
        });
    });
});

describe("Issue #47 — N4: surfaced on process()", () => {
    it("matched entry → noEmbed present with the pattern; channels unaffected", async () => {
        await withKnob(DEFAULT_LIST, async () => {
            const r = await mk().process({ path: "package-lock.json", ext: ".json", content: "{}" }, { channels: [] });
            assert.equal(r.noEmbed, "package-lock.json");
            assert.equal(r.ok, true);
        });
    });
    it("normal entry → field ABSENT", async () => {
        await withKnob(DEFAULT_LIST, async () => {
            const r = await mk().process({ path: "novel.txt", content: "call me ishmael\n" }, { channels: [] });
            assert.equal("noEmbed" in r, false);
        });
    });
});

describe("Issue #47 — N5: path-aware patterns (directory drawers)", () => {
    it("a /-pattern matches the full path — the run18 offender, verbatim", async () => {
        await withKnob("*/dist/*", () => {
            assert.equal(matchNoEmbed("/docs/src/.vuepress/dist/assets/js/12.5188bb.js"), "*/dist/*");
            assert.equal(matchNoEmbed("/src/distillery.js"), undefined, "'dist' inside a segment is not a drawer");
        });
    });
    it("relative-root drawers need the unanchored form", async () => {
        await withKnob("dist/*", () => {
            assert.equal(matchNoEmbed("dist/bundle.js"), "dist/*");
            assert.equal(matchNoEmbed("/repo/dist/bundle.js"), undefined, "anchored: no leading segments");
        });
    });
    it("basename patterns are unaffected by directories", async () => {
        await withKnob("*.map", () => {
            assert.equal(matchNoEmbed("/very/deep/dir/x.js.map"), "*.map");
        });
    });
    it("the shipped default now catches the hashed vuepress bundle", async () => {
        await withKnob(DEFAULT_LIST, () => {
            assert.equal(matchNoEmbed("/docs/src/.vuepress/dist/assets/js/12.5188bb.js"), "*/dist/*");
            assert.equal(matchNoEmbed("/books/novel.md"), undefined, "novel still embeds");
        });
    });
});

describe("Issue #47 — N6: ONE glob engine (body-matcher dialect parity)", () => {
    it("? and [...] work in NO_EMBED exactly as in the glob query dialect", async () => {
        await withKnob("chunk-?.js, *.mp[34]", () => {
            assert.equal(matchNoEmbed("/dist/chunk-7.js"), "chunk-?.js");
            assert.equal(matchNoEmbed("/dist/chunk-77.js"), undefined, "? is one char");
            assert.equal(matchNoEmbed("/media/song.mp3"), "*.mp[34]");
            assert.equal(matchNoEmbed("/media/song.mp5"), undefined);
        });
    });
});
