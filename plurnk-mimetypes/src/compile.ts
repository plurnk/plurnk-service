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
}

async function runChild(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { cwd, stdio: "inherit" });
        proc.on("error", reject);
        proc.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
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
