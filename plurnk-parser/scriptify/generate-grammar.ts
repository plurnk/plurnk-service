// The grammar build fails when antlr-ng reports an error, and the generated tree is replaced
// whole or not at all (#821). antlr-ng 1.0 exits 0 on grammar errors and prints them to stdout,
// so a bare `antlr-ng … && …` chain reports success over yesterday's lexer.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ANTLR = fileURLToPath(new URL("../../node_modules/.bin/antlr-ng", import.meta.url));
const ERROR_LINE = /^error\(\d+\)/mu;
const GENERATED_IMPORT = /from\s+(['"])\.\/([^'"]+)\.js\1/gu;

const antlr = (args: readonly string[], cwd: string): Promise<{ code: number; output: string }> => new Promise((accept) => {
    execFile(ANTLR, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        accept({ code, output: `${stdout}${stderr}` });
    });
});

export const generateGrammar = async ({ grammars, outDir, cwd = process.cwd() }: {
    readonly grammars: readonly string[];
    readonly outDir: string;
    readonly cwd?: string;
}): Promise<string> => {
    const target = resolve(cwd, outDir);
    // Staged beside the target so the final rename never crosses a filesystem.
    const stage = await mkdtemp(join(dirname(target), ".generated-"));
    try {
        const { code, output } = await antlr(
            ["-D", "language=TypeScript", "-o", stage, "--generate-visitor", "true", "--generate-listener", "false", ...grammars],
            cwd,
        );
        const errors = output.split("\n").filter((line) => ERROR_LINE.test(line));
        if (code !== 0 || errors.length > 0) {
            throw new Error(`antlr-ng reported ${errors.length} error(s) (exit ${code}); ${outDir} is unchanged:\n${output.trim()}`);
        }
        // The generated modules import each other as `.js`; the source tree runs them as `.ts`.
        for (const file of await readdir(stage)) {
            if (!file.endsWith(".ts")) continue;
            const path = join(stage, file);
            const original = await readFile(path, "utf8");
            const fixed = original.replace(GENERATED_IMPORT, "from $1./$2.ts$1");
            if (fixed !== original) await writeFile(path, fixed);
        }
        await rm(target, { recursive: true, force: true });
        await rename(stage, target);
        return output;
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
};

if (import.meta.main) {
    const output = await generateGrammar({ grammars: ["plurnkLexer.g4", "plurnkParser.g4"], outDir: "src/generated" });
    if (output.trim() !== "") process.stdout.write(`${output.trim()}\n`);
    console.log("grammar generated: src/generated");
}
