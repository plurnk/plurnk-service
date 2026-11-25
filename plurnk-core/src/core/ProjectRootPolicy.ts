// {§operator-config-workspace-settings}: operator-enforced project-root and membership confinement.
// Single three-state knob (`PLURNK_SERVICE_PROJECT_ROOT_BASE`): empty = unrestricted, `none` = headless-only,
// or an absolute path (`~/` expands) confining workspace roots beneath that base and jailing membership and
// file creation inside each workspace's own project root.

import { errnoCode, PathSyntax, type ProjectRootConfinement } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileCreateScope } from "./file-creation-policy.ts";
import HostPaths from "./HostPaths.ts";
import Results, { OperationFailureError } from "./results.ts";

export const PROJECT_ROOT_BASE_KEY = "PLURNK_SERVICE_PROJECT_ROOT_BASE";
const SYMLINK_HOPS = 40;

export type ParsedProjectRootPolicy =
    | { readonly mode: "unrestricted"; readonly base: null }
    | { readonly mode: "none"; readonly base: null }
    | { readonly mode: "confined"; readonly base: string };

const expandBasePath = (raw: string, env: NodeJS.ProcessEnv, home?: string): string => {
    const paths = new HostPaths({
        env: env.HOME === undefined ? {} : { HOME: env.HOME },
        ...(home === undefined ? {} : { home }),
    });
    return paths.expandUserPath(raw);
};

const invalidPolicy = (raw: string): ConfigurationError => new ConfigurationError(
    PROJECT_ROOT_BASE_KEY,
    `${PROJECT_ROOT_BASE_KEY} must be empty, 'none', or an absolute path (a leading ~/ expands); got ${JSON.stringify(raw)}.`,
);

export default class ProjectRootPolicy {
    static parse(env: NodeJS.ProcessEnv = process.env, home?: string): ParsedProjectRootPolicy {
        const raw = env[PROJECT_ROOT_BASE_KEY];
        if (raw === undefined || raw === "") {
            return { mode: "unrestricted", base: null };
        }
        if (raw === "none") {
            return { mode: "none", base: null };
        }
        if (!raw.isWellFormed() || raw.includes("\0") || raw.trim().length === 0) {
            throw invalidPolicy(raw);
        }
        const expanded = expandBasePath(raw, env, home);
        if (!isAbsolute(expanded)) {
            throw invalidPolicy(raw);
        }
        return { mode: "confined", base: resolve(expanded) };
    }

    static mode(env: NodeJS.ProcessEnv = process.env, home?: string): ProjectRootConfinement {
        return ProjectRootPolicy.parse(env, home).mode;
    }

    static clampScope(scope: FileCreateScope, env: NodeJS.ProcessEnv = process.env, home?: string): FileCreateScope {
        const { mode } = ProjectRootPolicy.parse(env, home);
        if (mode === "none") return "none";
        if (mode === "confined" && scope === "namespace") return "root";
        return scope;
    }

    // Resolve `target` through all existing symlink ancestors (and dangling symlink components) so
    // non-existent leaf paths and symlinked directories evaluate against their real physical location.
    static async resolvePhysical(target: string, hops = 0): Promise<string> {
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
                const code = errnoCode(cause);
                if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
            }
            // A dangling symlink fails realpath with ENOENT even though the link itself exists on disk.
            try {
                const st = await lstat(cursor);
                if (st.isSymbolicLink()) {
                    const linkTarget = await readlink(cursor);
                    const nextTarget = resolve(dirname(cursor), linkTarget);
                    const joined = tail.length === 0 ? nextTarget : join(nextTarget, ...tail);
                    return ProjectRootPolicy.resolvePhysical(joined, hops + 1);
                }
            } catch (cause) {
                const code = errnoCode(cause);
                if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
            }
            const parent = dirname(cursor);
            if (parent === cursor) return absolute;
            tail.unshift(basename(cursor));
            cursor = parent;
        }
    }

    static async isWithinDirectory(directory: string, candidate: string): Promise<boolean> {
        let realDir: string;
        let realCandidate: string;
        try {
            [realDir, realCandidate] = await Promise.all([
                ProjectRootPolicy.resolvePhysical(directory),
                ProjectRootPolicy.resolvePhysical(candidate),
            ]);
        } catch (cause) {
            if (errnoCode(cause) === "ELOOP") return false;
            throw cause;
        }
        const rel = relative(realDir, realCandidate);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    }

    // Leading non-glob directory/file prefix of a canonical workspace-relative glob pattern.
    static staticPrefixOfGlob(pattern: string): string {
        const segments = pattern.split("/");
        const prefix: string[] = [];
        for (const segment of segments) {
            if (segment.length === 0) continue;
            if (PathSyntax.hasGlob(segment)) break;
            prefix.push(segment);
        }
        return prefix.join("/");
    }

    static async isRootAdmitted(
        projectRoot: string | null,
        env: NodeJS.ProcessEnv = process.env,
        home?: string,
    ): Promise<boolean> {
        const policy = ProjectRootPolicy.parse(env, home);
        if (policy.mode === "unrestricted") return true;
        if (projectRoot === null) return true;
        if (policy.mode === "none") return false;
        return ProjectRootPolicy.isWithinDirectory(policy.base, projectRoot);
    }

    static async assertAdmitted(
        projectRoot: string | null,
        env: NodeJS.ProcessEnv = process.env,
        home?: string,
    ): Promise<void> {
        let policy: ParsedProjectRootPolicy;
        try {
            policy = ProjectRootPolicy.parse(env, home);
        } catch (cause) {
            if (cause instanceof ConfigurationError) {
                throw new OperationFailureError(Results.configurationFailure(cause), { cause });
            }
            throw cause;
        }
        if (policy.mode === "unrestricted" || projectRoot === null) return;
        if (policy.mode === "none") {
            throw new OperationFailureError(Results.failure(
                "daemon:workspace",
                "project-root-forbidden",
                403,
                "Project roots are disabled by operator policy; only headless workspaces are admitted.",
                {},
                {
                    recovery: "Omit projectRoot or pass null to open a headless workspace.",
                    retryable: false,
                },
            ));
        }
        if (!(await ProjectRootPolicy.isWithinDirectory(policy.base, projectRoot))) {
            throw new OperationFailureError(Results.failure(
                "daemon:workspace",
                "project-root-confined",
                403,
                "The requested project root is outside the operator-permitted directory.",
                {},
                {
                    projectRoot,
                    recovery: "Choose a project root inside the operator-permitted directory.",
                    retryable: false,
                },
            ));
        }
    }
}
