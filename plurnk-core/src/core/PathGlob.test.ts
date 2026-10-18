import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import PathGlob from "./PathGlob.ts";

test("{§path-glob-matching} traversal and matching select the same literal names and shell patterns", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "plurnk-path-glob-"));
    const root = join(temporary, String.raw`base\[1]`);
    const names = [
        String.raw`dir\name/a.txt`, "dir/name/a.txt", "dirname/a.txt",
        "a*.txt", "a/b.txt", "a?.txt", "abc.txt", "a[1].txt", "a{b}.txt",
        "#name.txt", "!name.txt", ".hidden.txt", "src/.hidden.ts",
        "src/a.ts", "src/b.js", "src/deep/c.ts", "range/1.txt", "range/2.txt", "range/3.txt",
    ];
    const cases: Array<[string, string[]]> = [
        [String.raw`dir\\name/*.txt`, [String.raw`dir\name/a.txt`]],
        [String.raw`a\*.txt`, ["a*.txt"]],
        [String.raw`a\?.txt`, ["a?.txt"]],
        [String.raw`a\[1\].txt`, ["a[1].txt"]],
        [String.raw`a\{b\}.txt`, ["a{b}.txt"]],
        ["#*.txt", ["#name.txt"]],
        ["!*.txt", ["!name.txt"]],
        ["src/*.{ts,js}", ["src/a.ts", "src/b.js"]],
        ["src/@(a|b).*", ["src/a.ts", "src/b.js"]],
        ["src/[ab].*", ["src/a.ts", "src/b.js"]],
        ["src/**/*.ts", ["src/a.ts", "src/deep/c.ts"]],
        ["src/.hidden.*", ["src/.hidden.ts"]],
        ["range/{1..2}.txt", ["range/1.txt", "range/2.txt"]],
    ];
    const scan = async (pattern: string): Promise<string[]> => {
        const paths: string[] = [];
        for await (const path of PathGlob.iterate(pattern, root)) paths.push(path);
        return paths;
    };
    try {
        for (const name of names) {
            await mkdir(dirname(join(root, name)), { recursive: true });
            await writeFile(join(root, name), name);
        }
        for (const [pattern, expected] of cases) {
            const traversed = await scan(pattern);
            assert.deepEqual(traversed.toSorted(), expected.toSorted(), `scan ${pattern}`);
            assert.deepEqual(names.filter((name) => PathGlob.matches(name, pattern)).toSorted(), expected.toSorted(), `match ${pattern}`);
        }
        for (const name of names) {
            const escaped = PathGlob.escape(name);
            assert.deepEqual(await scan(escaped), [name], `literal scan ${name}`);
            assert.deepEqual(names.filter((candidate) => PathGlob.matches(candidate, escaped)), [name], `literal match ${name}`);
        }
    } finally { await rm(temporary, { recursive: true, force: true }); }
});
