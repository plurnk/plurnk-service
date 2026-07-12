import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface CompileOptions {
    grammarDir?: string;
    outDir?: string;
    cwd?: string;
}

// Compile a handler's vendored ANTLR4 grammars to TypeScript via antlr-ng.
// Looks in `grammar/` (or opts.grammarDir) for .g4 files, runs antlr-ng with
// the TypeScript target + visitor generation, lands output in `src/generated/`
// (or opts.outDir). Post-processes the generated files to rewrite .js import
// extensions to .ts so Node's native TypeScript resolution works without a
// separate compile pass.
export async function runCompile(opts: CompileOptions = {}): Promise<void> {
    const cwd = opts.cwd ?? process.cwd();
    const grammarDir = path.resolve(cwd, opts.grammarDir ?? "grammar");
    const outDir = path.resolve(cwd, opts.outDir ?? "src/generated");

    let files: string[];
    try {
        files = (await fs.readdir(grammarDir)).filter((f) => f.endsWith(".g4"));
    } catch {
        throw new Error(`Grammar directory not found: ${grammarDir}`);
    }
    if (files.length === 0) {
        throw new Error(`No .g4 files found in ${grammarDir}`);
    }

    await fs.mkdir(outDir, { recursive: true });

    const args = [
        "-D", "language=TypeScript",
        "-o", outDir,
        "--generate-visitor", "true",
        "--generate-listener", "false",
        ...files,
    ];

    await runChild("antlr-ng", args, grammarDir);
    await rewriteImports(outDir);
    await injectBaseImports(outDir);
}

async function runChild(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { cwd, stdio: "inherit" });
        proc.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") {
                reject(new Error(
                    `${cmd} not found on PATH. ANTLR-backed handlers need ` +
                    `antlr-ng + antlr4ng in their own devDependencies:\n\n` +
                    `  npm install --save-dev antlr-ng@^1.0.10 antlr4ng@^3.0.0\n\n` +
                    `Then invoke via \`npx plurnk-mimetypes-compile\` so npx ` +
                    `puts node_modules/.bin on PATH for the spawn.`,
                ));
            } else {
                reject(err);
            }
        });
        proc.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

// Inject `import <BaseName> from "./<BaseName>.ts"` into any generated file
// whose top-level class extends a `*Base` superclass that isn't already
// imported. antlr-ng emits the `extends FooBase` clause from the grammar's
// `superClass = FooBase` option but doesn't write the import — without this
// step the generated parser/lexer fail to compile. Exposed as an importable
// utility for handlers integrating the post-process into a custom pipeline.
export async function injectBaseImports(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await injectBaseImports(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            const content = await fs.readFile(fullPath, "utf-8");
            const match = content.match(/^export class \w+ extends (\w+Base)\b/m);
            if (match === null) continue;
            const baseName = match[1];
            const importLine = `import ${baseName} from "./${baseName}.ts";`;
            if (content.includes(importLine)) continue;
            // Inject after the last existing top-of-file import, or at the very top.
            const lastImportEnd = findLastImportEnd(content);
            const updated = lastImportEnd > 0
                ? `${content.slice(0, lastImportEnd)}\n${importLine}${content.slice(lastImportEnd)}`
                : `${importLine}\n${content}`;
            await fs.writeFile(fullPath, updated);
        }
    }
}

// Find the position immediately after the last `import ... from "...";` line
// in the head of the file. Returns 0 if no imports are found.
function findLastImportEnd(content: string): number {
    const lines = content.split("\n");
    let endByte = 0;
    let byte = 0;
    for (const line of lines) {
        if (/^\s*import\b/.test(line)) {
            endByte = byte + line.length;
        } else if (line.trim().length > 0 && endByte > 0) {
            break;
        }
        byte += line.length + 1; // include the \n
    }
    return endByte;
}

// Rewrite .js import extensions to .ts in every .ts file under `dir`. Exposed
// as an importable utility for handler repos that want to integrate the
// import-fixup step into their own build pipeline rather than calling the
// compile bin (e.g., a custom scriptify/fix-imports.ts script).
export async function rewriteImports(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await rewriteImports(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            const content = await fs.readFile(fullPath, "utf-8");
            const rewritten = content.replace(
                /from\s+(['"])(\.\.?\/[^'"]+?)\.js\1/g,
                "from $1$2.ts$1",
            );
            if (rewritten !== content) {
                await fs.writeFile(fullPath, rewritten);
            }
        }
    }
}

export async function cli(argv: string[]): Promise<void> {
    if (argv.includes("-h") || argv.includes("--help")) {
        console.log(`Usage: plurnk-mimetypes-compile

Compile ANTLR4 grammars in ./grammar/ to ./src/generated/ via antlr-ng,
targeting TypeScript output. Rewrites .js import extensions to .ts so
Node's native TS resolution works without a build step.

Run from a handler repo's root directory.`);
        return;
    }
    await runCompile();
    console.log("Compile complete.");
}
