import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const TEMPLATE_DIR = path.join(import.meta.dirname, "..", "templates", "handler");

export interface InitOptions {
    mimetype: string;
    out: string;
    glyph: string;
    extensions: string[];
    version: string;
}

export interface InitResult {
    outDir: string;
    files: string[];
}

// Scaffold a new @plurnk/plurnk-mimetypes-* handler repo by copying the
// templates/handler/ tree, substituting placeholders, and renaming the
// handler class file based on the mimetype.
export async function runInit(opts: InitOptions): Promise<InitResult> {
    const outDir = path.resolve(opts.out);

    if (await exists(outDir)) {
        throw new Error(`Refusing to overwrite existing directory: ${outDir}`);
    }

    const className = mimetypeToClassName(opts.mimetype);
    const subs = substitutions(opts, className);
    const templateFiles = await walkTemplate(TEMPLATE_DIR);

    const written: string[] = [];
    for (const relativePath of templateFiles) {
        const srcPath = path.join(TEMPLATE_DIR, relativePath);
        const renamed = renameTemplateFile(relativePath, className);
        const destPath = path.join(outDir, renamed);

        await fs.mkdir(path.dirname(destPath), { recursive: true });
        const content = await fs.readFile(srcPath, "utf-8");
        const transformed = applySubstitutions(content, subs);
        await fs.writeFile(destPath, transformed);
        written.push(renamed);
    }

    return { outDir, files: written.sort() };
}

export function mimetypeToSafeName(mimetype: string): string {
    return mimetype.replace(/[\/+]/g, "-").toLowerCase();
}

export function mimetypeToClassName(mimetype: string): string {
    return mimetype
        .replace(/[\/+\-_.]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join("");
}

function substitutions(opts: InitOptions, className: string): Record<string, string> {
    return {
        "{{PACKAGE_NAME}}": `@plurnk/plurnk-mimetypes-${mimetypeToSafeName(opts.mimetype)}`,
        "{{MIMETYPE}}": opts.mimetype,
        "{{CLASS_NAME}}": className,
        "{{GLYPH}}": opts.glyph,
        "{{EXTENSIONS}}": JSON.stringify(opts.extensions),
        "{{PLURNK_MIMETYPES_VERSION}}": opts.version,
    };
}

function applySubstitutions(content: string, subs: Record<string, string>): string {
    let out = content;
    for (const [key, value] of Object.entries(subs)) {
        out = out.split(key).join(value);
    }
    return out;
}

function renameTemplateFile(relativePath: string, className: string): string {
    // _gitignore → .gitignore so the template's own gitignore rules don't
    // shadow the template files themselves in OUR repo (git would otherwise
    // ignore templates/handler/AGENTS.md because the template lists AGENTS.md).
    return relativePath
        .replace(/(^|\/)Handler\.test\.ts$/, `$1${className}.test.ts`)
        .replace(/(^|\/)Handler\.ts$/, `$1${className}.ts`)
        .replace(/(^|\/)_gitignore$/, "$1.gitignore");
}

async function walkTemplate(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, prefix: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), relative);
            } else if (entry.isFile()) {
                out.push(relative);
            }
        }
    }
    await walk(root, "");
    return out;
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

export async function cli(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            out: { type: "string" },
            glyph: { type: "string", default: "📄" },
            extensions: { type: "string", default: "" },
            help: { type: "boolean", short: "h" },
        },
    });

    if (values.help || positionals.length === 0) {
        printUsage();
        return;
    }

    const mimetype = positionals[0];
    const safeName = mimetypeToSafeName(mimetype);
    const outDir = values.out ?? path.join("..", `plurnk-mimetypes-${safeName}`);

    const extensions = values.extensions === ""
        ? []
        : values.extensions.split(",").map((e) => e.trim()).filter(Boolean);

    const ownPackagePath = path.join(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(await fs.readFile(ownPackagePath, "utf-8")) as { version: string };
    const version = `^${pkg.version}`;

    const result = await runInit({
        mimetype,
        out: outDir,
        glyph: values.glyph as string,
        extensions,
        version,
    });

    console.log(`Scaffolded ${result.files.length} files in ${result.outDir}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  cd ${result.outDir}`);
    console.log("  npm install");
    console.log("  npm test");
}

function printUsage(): void {
    console.log(`Usage: plurnk-mimetypes-init <mimetype> [options]

Scaffold a new @plurnk/plurnk-mimetypes-* handler repo.

Arguments:
  <mimetype>          The mimetype to handle (e.g., text/x-python).

Options:
  --out <dir>         Output directory (default: ../plurnk-mimetypes-<safe-name>)
  --glyph <emoji>     Glyph for the handler (default: 📄)
  --extensions <list> Comma-separated extensions and filenames
                      (e.g., .py,.pyw or .dockerfile,Dockerfile)
  -h, --help          Show this message.

Examples:
  plurnk-mimetypes-init text/plain --extensions .txt
  plurnk-mimetypes-init text/x-python --glyph 🐍 --extensions .py,.pyw
  plurnk-mimetypes-init application/json --extensions .json,.jsonc`);
}
