import { globIterate } from "glob";
import { escape, minimatch } from "minimatch";

// {§find} Node's fixed windowsPathsNoEscape setting cannot express
// POSIX filename escapes. Matching and disk traversal use the same public engine.
const options = {
    windowsPathsNoEscape: false,
    nonegate: true,
    nocomment: true,
    nocase: process.platform === "win32" || process.platform === "darwin",
    nocaseMagicOnly: true,
    optimizationLevel: 2,
};

export default class PathGlob {
    static matches(pathname: string, pattern: string): boolean {
        return minimatch(pathname, pattern, options);
    }

    static iterate(pattern: string, cwd: string): AsyncGenerator<string, void, void> {
        return globIterate(pattern, { ...options, cwd });
    }

    static escape(literal: string): string {
        return escape(literal, { magicalBraces: true });
    }
}
