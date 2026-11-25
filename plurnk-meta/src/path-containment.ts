// {§operator-config-workspace-settings} — shared physical filesystem containment helpers.
// Resolves through existing symlink ancestors and dangling symlinks without touching files outside the check.
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SYMLINK_HOPS = 40;

const errnoOf = (cause: unknown): string | undefined => {
    if (cause === null || typeof cause !== "object") return undefined;
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
};

export const isLexicallyWithinDirectory = (directory: string, candidate: string): boolean => {
    const rel = relative(resolve(directory), resolve(candidate));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Resolve `target` through all existing symlink ancestors (and dangling symlink components) so
// non-existent leaf paths and symlinked directories evaluate against their real physical location.
export const resolvePhysical = async (target: string, hops = 0): Promise<string> => {
    if (hops > SYMLINK_HOPS) {
        throw Object.assign(new Error(`Too many levels of symbolic links while resolving '${target}'.`), { code: "ELOOP" });
    }
    const absolute = resolve(target);
    const tail: string[] = [];
    let cursor = absolute;
    while (true) {
        try {
            const real = await realpath(cursor);
            return tail.length === 0 ? real : join(real, ...tail);
        } catch (cause) {
            const code = errnoOf(cause);
            if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        }
        // A dangling symlink fails realpath with ENOENT even though the link itself exists on disk.
        try {
            const st = await lstat(cursor);
            if (st.isSymbolicLink()) {
                const linkTarget = await readlink(cursor);
                const nextTarget = resolve(dirname(cursor), linkTarget);
                const joined = tail.length === 0 ? nextTarget : join(nextTarget, ...tail);
                return resolvePhysical(joined, hops + 1);
            }
        } catch (cause) {
            const code = errnoOf(cause);
            if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        }
        const parent = dirname(cursor);
        if (parent === cursor) return absolute;
        tail.unshift(basename(cursor));
        cursor = parent;
    }
};

export const isWithinDirectory = async (directory: string, candidate: string): Promise<boolean> => {
    let realDir: string;
    let realCandidate: string;
    try {
        [realDir, realCandidate] = await Promise.all([
            resolvePhysical(directory),
            resolvePhysical(candidate),
        ]);
    } catch (cause) {
        if (errnoOf(cause) === "ELOOP") return false;
        throw cause;
    }
    const rel = relative(realDir, realCandidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
