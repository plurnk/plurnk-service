#!/usr/bin/env node
// Scaffold a new @plurnk/plurnk-mimetypes-text-<lang> package from a manifest
// entry. Produces the skeleton — package.json, tsconfig pair, LICENSE, README,
// .gitignore, src/index.ts, a Visitor stub, a test stub — and copies grammar
// files from vendor/grammars-v4/. The Visitor itself is per-grammar
// handwork; the stub provides the wiring scaffold so the author only has to
// fill in node-name → SymbolKind mappings.
//
// Usage:
//   node scripts/scaffold-language.js <manifest-id> <lang-slug> <mimetype> <glyph> <ext> [ext...]
//
// Example:
//   node scripts/scaffold-language.js python--python3 python text/python 🐍 .py .pyw

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const MIMETYPES_ROOT = path.dirname(import.meta.dirname);
const SIBLINGS_ROOT = path.dirname(MIMETYPES_ROOT);

const args = process.argv.slice(2);
if (args.length < 5) {
    console.error("usage: scaffold-language <manifest-id> <lang-slug> <mimetype> <glyph> <ext> [ext...]");
    console.error("example: scaffold-language python--python3 python text/python 🐍 .py .pyw");
    process.exit(2);
}

const [manifestId, langSlug, mimetype, glyph, ...extensions] = args;
const className = pascalCase(langSlug);                 // "python" → "TextPython"
const handlerClassName = `Text${pascalCase(langSlug)}`;
const packageName = `@plurnk/plurnk-mimetypes-text-${langSlug}`;
const packageDir = path.join(SIBLINGS_ROOT, `plurnk-mimetypes-text-${langSlug}`);

// Look up the manifest entry to copy grammar files.
const manifest = JSON.parse(await fs.readFile(path.join(MIMETYPES_ROOT, "languages/manifest.json"), "utf-8"));
const entry = manifest.find((e) => e.id === manifestId);
if (!entry) {
    console.error(`manifest entry not found: ${manifestId}`);
    process.exit(1);
}

const grammarSourceDir = path.join(MIMETYPES_ROOT, entry.grammarDir);
const grammarFiles = entry.g4Files;

// Probe the lexer name from the g4 filename ("FooLexer.g4" → "Foo").
// Convention: the ANTLR-generated parser/lexer/visitor classes are named
// <Stem>Lexer / <Stem>Parser / <Stem>ParserVisitor. We use the lexer file's
// stem to derive Stem.
const lexerFile = grammarFiles.find((f) => /Lexer\.g4$/i.test(f));
const parserFile = grammarFiles.find((f) => /Parser\.g4$/i.test(f));
const grammarStem = lexerFile?.replace(/Lexer\.g4$/i, "") ?? langSlug;
const parserStem = parserFile?.replace(/Parser\.g4$/i, "") ?? grammarStem;
const parserRule = "compilationUnit"; // common default; author may need to adjust

console.log(`scaffolding ${packageName}`);
console.log(`  manifest:       ${manifestId}`);
console.log(`  grammar source: ${entry.grammarDir}`);
console.log(`  grammar stem:   ${grammarStem}`);
console.log(`  package dir:    ${packageDir}`);

await fs.mkdir(packageDir, { recursive: true });
await fs.mkdir(path.join(packageDir, "grammar"), { recursive: true });
await fs.mkdir(path.join(packageDir, "src"), { recursive: true });
await fs.mkdir(path.join(packageDir, "src/generated"), { recursive: true });

// Copy grammar files.
for (const f of grammarFiles) {
    const src = path.join(grammarSourceDir, f);
    const dst = path.join(packageDir, "grammar", f);
    await fs.copyFile(src, dst);
    console.log(`  copied grammar/${f}`);
}

// Vendored base classes — some grammars declare `superClass = FooParserBase`
// or `superClass = FooLexerBase`, in which case the runtime helper class needs
// to be present in src/generated/ for the generated parser/lexer to compile.
// Grammars-v4 ships TypeScript implementations of these under
// <grammarDir>/TypeScript/. Copy them when present and track them in git
// (the gitignore exception is written below).
const baseFiles = [];
const tsHelperDir = path.join(grammarSourceDir, "TypeScript");
try {
    const candidates = await fs.readdir(tsHelperDir);
    for (const f of candidates) {
        if (/Base\.ts$/.test(f)) {
            await fs.copyFile(path.join(tsHelperDir, f), path.join(packageDir, "src/generated", f));
            baseFiles.push(f);
            console.log(`  copied src/generated/${f}`);
        }
    }
} catch {
    // No TypeScript/ helper dir — many grammars don't need one.
}

// Compose the extension array for plurnk.handlers.
const exts = extensions.length > 0 ? extensions : [];

const pkg = {
    name: packageName,
    version: "0.1.0",
    description: `${mimetype} mimetype handler for plurnk-service. ANTLR-backed extraction via grammars-v4.`,
    type: "module",
    license: "MIT",
    publishConfig: { access: "public" },
    engines: { node: ">=25" },
    plurnk: {
        kind: "mimetype",
        handlers: [
            { name: mimetype, glyph, extensions: exts },
        ],
    },
    exports: {
        ".": {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
        },
        "./package.json": "./package.json",
    },
    files: ["dist/**/*", "grammar/**/*", "README.md"],
    scripts: {
        "test:lint": "tsc --noEmit",
        "test:unit": "node --test src/**/*.test.ts",
        test: "npm run test:lint && npm run test:unit",
        "build:grammar": "plurnk-mimetypes-compile",
        "build:dist": "tsc -p tsconfig.build.json",
        build: "npm run build:grammar && npm run build:dist",
        prepare: "npm run build",
    },
    dependencies: {
        "@plurnk/plurnk-mimetypes": "^0.7.0",
        antlr4ng: "^3.0.0",
    },
    devDependencies: {
        "@types/node": "^25.8.0",
        "antlr-ng": "^1.0.10",
        typescript: "^6.0.3",
    },
};
await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify(pkg, null, 4) + "\n");
console.log("  wrote package.json");

// tsconfig (same as text-typescript template)
const tsconfig = {
    compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        types: ["node"],
        lib: ["ES2024"],
    },
    include: ["src/**/*.ts"],
    exclude: ["node_modules", "dist"],
};
await fs.writeFile(path.join(packageDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 4) + "\n");

const tsconfigBuild = {
    extends: "./tsconfig.json",
    compilerOptions: {
        noEmit: false,
        outDir: "./dist",
        rootDir: "./src",
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        allowImportingTsExtensions: false,
        rewriteRelativeImportExtensions: true,
    },
    include: ["src/**/*.ts"],
    exclude: ["node_modules", "dist", "**/*.test.ts"],
};
await fs.writeFile(path.join(packageDir, "tsconfig.build.json"), JSON.stringify(tsconfigBuild, null, 4) + "\n");
console.log("  wrote tsconfig pair");

// .gitignore — generated parser/lexer/visitor is build output (npm run
// build:grammar regenerates). Any vendored *Base.ts helpers stay tracked via
// negation entries.
const gitignoreLines = [
    "node_modules/",
    "dist/",
    "*.tgz",
    "*.log",
    ".DS_Store",
    "AGENTS.md",
    "",
    "# antlr-ng generated parser/lexer/visitor — built by `npm run build:grammar`.",
    "src/generated/*",
];
for (const f of baseFiles) gitignoreLines.push(`!src/generated/${f}`);
gitignoreLines.push("");
await fs.writeFile(path.join(packageDir, ".gitignore"), gitignoreLines.join("\n"));
console.log("  wrote .gitignore");

// LICENSE — copy from text-typescript.
const license = await fs.readFile(
    path.join(SIBLINGS_ROOT, "plurnk-mimetypes-text-typescript/LICENSE"),
    "utf-8",
);
await fs.writeFile(path.join(packageDir, "LICENSE"), license);
console.log("  wrote LICENSE");

// README skeleton.
const readme = [
    `# @plurnk/plurnk-mimetypes-text-${langSlug}`,
    "",
    `${mimetype} mimetype handler for plurnk-service. ANTLR-backed extraction using grammars-v4's \`${entry.grammarDir.replace("vendor/grammars-v4/", "")}\` grammar.`,
    "",
    "## Symbols emitted",
    "",
    "Per SPEC §3 inclusion policy: classes, functions, methods, fields, interfaces, enums, types, modules, variables, constants. Imports excluded; locals inside function bodies excluded.",
    "",
    "## Install",
    "",
    "```bash",
    `npm install ${packageName}`,
    "```",
    "",
    "Auto-discovered by `@plurnk/plurnk-mimetypes` when installed alongside it.",
    "",
].join("\n");
await fs.writeFile(path.join(packageDir, "README.md"), readme);
console.log("  wrote README.md");

// src/index.ts
const indexTs = `export { default as ${handlerClassName} } from "./${handlerClassName}.ts";\nexport { default } from "./${handlerClassName}.ts";\n`;
await fs.writeFile(path.join(packageDir, "src/index.ts"), indexTs);
console.log("  wrote src/index.ts");

// src/<Class>.ts — Visitor stub. The author has to:
// 1. Implement parseTree (lex → tokens → parse → entry-rule context)
// 2. Customize the Visitor with visit<NodeName> handlers per the grammar
const handlerTs = `import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { ${grammarStem}Lexer } from "./generated/${grammarStem}Lexer.ts";
import { ${parserStem}Parser } from "./generated/${parserStem}Parser.ts";
import { ${parserStem}ParserVisitor } from "./generated/${parserStem}ParserVisitor.ts";

// ${mimetype} handler. ANTLR grammar from grammars-v4 (${entry.grammarDir.replace("vendor/grammars-v4/", "")}).
//
// The grammar's parser-entry rule is invoked from parseTree. Override visit<NodeName>
// handlers in the visitor below for each declaration kind per SPEC §3.
export default class ${handlerClassName} extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new ${grammarStem}Lexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new ${parserStem}Parser(tokens);
        parser.removeErrorListeners();
        // TODO(scaffold): confirm \`${parserRule}\` is the right entry rule for this grammar.
        // Common entry rules: program, compilationUnit, sourceFile, translationUnit, root.
        return parser.${parserRule}();
    }

    protected createVisitor(): ExtractionVisitor {
        return new ${handlerClassName}Visitor() as unknown as ExtractionVisitor;
    }
}

// Visitor: extend the antlr4ng-generated ${parserStem}ParserVisitor through the
// framework's withExtractor mixin (adds symbols/inBody/addSymbol/gateBody).
//
// SPEC §3 inclusion policy: include classes, functions, methods, fields, interfaces,
// enums, types, modules, variables, constants. Exclude imports, locals inside
// function bodies, unexported module-scope variables (when applicable).
class ${handlerClassName}Visitor extends withExtractor(${parserStem}ParserVisitor) {
    // TODO(scaffold): implement visit<NodeName> handlers per the grammar. Pattern:
    //
    //   visitFunctionDeclaration = (ctx: any): null => {
    //       if (this.inBody) return null;
    //       const id = ctx.identifier();
    //       const params = extractParams(ctx.parameterList?.());
    //       if (id) this.addSymbol("function", id.getText(), ctx, params);
    //       this.visitChildren(ctx);
    //       return null;
    //   };
    //
    //   visitClassDeclaration = (ctx: any): null => {
    //       if (this.inBody) return null;
    //       const id = ctx.identifier();
    //       if (id) this.addSymbol("class", id.getText(), ctx);
    //       this.visitChildren(ctx);
    //       return null;
    //   };
    //
    //   visitFunctionBody = (ctx: any): null => this.gateBody(ctx);
}
`;
await fs.writeFile(path.join(packageDir, `src/${handlerClassName}.ts`), handlerTs);
console.log(`  wrote src/${handlerClassName}.ts`);

// src/<Class>.test.ts — test stub
const testTs = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ${handlerClassName} from "./${handlerClassName}.ts";

const metadata = {
    mimetype: "${mimetype}",
    glyph: "${glyph}",
    extensions: [${exts.map((e) => JSON.stringify(e)).join(", ")}] as const,
};

describe("${handlerClassName} — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new ${handlerClassName}(metadata);
        assert.equal(h.mimetype, "${mimetype}");
        assert.equal(h.glyph, "${glyph}");
    });
});

describe("${handlerClassName} — extract", () => {
    // TODO(scaffold): add coverage for the language's primary declaration kinds.
    // Reference text-typescript's test suite for the patterns:
    //   - extracts a top-level function with parameters
    //   - extracts a class with its methods and fields
    //   - extracts interface/type/enum declarations where applicable
    //   - excludes imports per SPEC §3
    //   - excludes local variables inside function bodies
    //   - excludes unexported module-scope variables (if the language has module privacy)
    //   - returns empty array for content with no extractable declarations
    //   - returns empty array on a parse failure (graceful)

    it("returns empty array for empty input", () => {
        const h = new ${handlerClassName}(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });
});
`;
await fs.writeFile(path.join(packageDir, `src/${handlerClassName}.test.ts`), testTs);
console.log(`  wrote src/${handlerClassName}.test.ts`);

console.log("");
console.log("Next steps:");
console.log(`  cd ${packageDir}`);
console.log("  npm install");
console.log("  # adjust parser entry rule in parseTree if the grammar uses a different name");
console.log("  # implement visit* handlers in the Visitor for the grammar's declaration kinds");
console.log("  # write tests against representative source snippets");
console.log("  npm test");
console.log("  npm run build");

function pascalCase(s) {
    return s
        .split(/[-_]/)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
}
