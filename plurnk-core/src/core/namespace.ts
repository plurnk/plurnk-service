// {§fs-namei} {§fs-canonical-name} Lexical resolution only; membership and physical
// symlink checks belong to the file owner.
import { posix } from "node:path";
import { homedir } from "node:os";

export default class Namespace {
    static isHomeRelative(spelling: string): boolean {
        return spelling === "~" || spelling.startsWith("~/");
    }

    // {§fs-home} Call only for authored input, never for a bound entry key.
    static expandHome(spelling: string, home: string = homedir()): string {
        return Namespace.isHomeRelative(spelling) ? `${home}${spelling.slice(1)}` : spelling;
    }

    static literalSpelling(key: string): string {
        return Namespace.isHomeRelative(key) ? `./${key}` : key;
    }

    // Git reports repository-relative paths; storage is workspace-relative.
    static fromRepositoryPath(repositoryPath: string, workspaceRoot: string, repositoryRoot: string): string {
        if (repositoryPath.length === 0 || repositoryPath.startsWith("/") || repositoryPath.includes("\0")) {
            throw new TypeError(`Git returned a malformed repository pathname: ${JSON.stringify(repositoryPath)}`);
        }
        const repository = posix.resolve("/", repositoryRoot);
        const absolute = posix.resolve(repository, repositoryPath);
        const prefix = repository === "/" ? "/" : `${repository}/`;
        if (absolute !== repository && !absolute.startsWith(prefix)) {
            throw new TypeError(`Git pathname escapes its repository: ${JSON.stringify(repositoryPath)}`);
        }
        const key = posix.relative(posix.resolve("/", workspaceRoot), absolute);
        const canonical = Namespace.canonicalize(key, workspaceRoot);
        if (canonical === null) {
            throw new TypeError(`Git pathname does not name a workspace file: ${JSON.stringify(repositoryPath)}`);
        }
        return canonical;
    }

    static canonicalize(spelling: string, root: string | null): string | null {
        const key = Namespace.#relative(spelling, root);
        return key === null || key.length === 0 || posix.basename(key) === ".." ? null : key;
    }

    // {§fs-namei} Only the project directory becomes the empty collection.
    static canonicalizeSpelling(raw: string, root: string | null, home: string = homedir()): string | null {
        const key = Namespace.#relative(Namespace.expandHome(raw, home), root);
        if (key === null || key.length === 0) return key;
        const last = posix.basename(raw);
        const folder = raw === "~" || raw.endsWith("/") || last === "." || last === ".." || posix.basename(key) === "..";
        return folder ? `${key}/` : key;
    }

    static #relative(spelling: string, root: string | null): string | null {
        if (spelling.includes("\0") || (root === null && posix.isAbsolute(spelling))) return null;
        const key = root === null
            ? posix.normalize(spelling).replace(/\/$/u, "")
            : posix.relative(root, posix.resolve(root, spelling));
        return key === "." ? "" : key;
    }

    // True when `key` is already canonical — the fixpoint the world-state invariant
    // asserts over every stored file-class pathname: canon(key, root) === key.
    static isCanonical(key: string, root: string | null): boolean {
        return Namespace.canonicalize(key, root) === key;
    }
}
