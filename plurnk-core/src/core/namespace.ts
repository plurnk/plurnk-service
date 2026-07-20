// The workspace filesystem's ONE pathname resolver ({§fs-namei}, {§fs-canonical-name}).
// Every file-class spelling the model types passes through canonicalize() before it may
// touch storage, comparison, or any engine-authored render — the database never receives
// a model spelling. Pure string math (no fs access; symlinks are out of scope by design —
// membership materializes real files, not links): the entry-existence questions belong to
// the membership gate downstream, never here. Canon follows gitformat-index(5) (git 2.47.3):
// bare root-relative keys, '/'-separated, no leading slash, no '.'/'..' components in the
// tail, no trailing slash, no NUL — with the documented overlay extension of a LEADING run
// of '..' segments naming a declared outside-root mount.
import { posix } from "node:path";

export default class Namespace {
    // Model spelling → canonical member key, or null when the spelling names nothing a
    // file entry can be: empty, NUL-bearing, or resolving to a directory (the root, a bare
    // mount run) — directories are never entries; files only, as git. `root` is the
    // workspace's project_root (the model's '/'): a spelling that walks OUT of the tree and
    // back IN (the owner's ../../../home/bob/project/example.md class) re-relativizes to
    // its bare key, exactly as git resolves a worktree path typed from anywhere.
    static canonicalize(spelling: string, root: string | null): string | null {
        if (spelling.length === 0 || spelling.includes("\0")) return null;
        // CWD is permanently '/' ({§fs-namei}): a leading slash is the same name.
        const stripped = spelling.replace(/^\/+/, "");
        const out: string[] = [];
        for (const segment of stripped.split("/")) {
            if (segment === "" || segment === ".") continue;
            if (segment === "..") {
                // lexical namei: pop inside the tree; beyond the root, accumulate the
                // leading mount run (the git-style outside-root overlay notation).
                if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
                else out.push("..");
                continue;
            }
            out.push(segment);
        }
        if (out.length === 0) return null;
        if (out[0] === "..") {
            // Headless (no root) has no host geometry: a ..-run stays the mount-key form
            // verbatim — only the out-and-back-in re-entry needs the real root to resolve.
            if (root === null) return out[out.length - 1] === ".." ? null : out.join("/");
            // A mount-run spelling may walk back INTO the tree (out-and-back-in aliasing):
            // resolve it against the real root; under the root it IS the bare key.
            const normalRoot = posix.resolve("/", root);
            const resolved = posix.resolve(normalRoot, out.join("/"));
            if (resolved === normalRoot) return null; // the root itself — never an entry
            const prefix = normalRoot === "/" ? "/" : `${normalRoot}/`;
            if (resolved.startsWith(prefix)) return resolved.slice(prefix.length);
            // genuinely outside: the declared-mount key, re-relativized so the '..' run is
            // minimal and the tail is dot-free (gitformat-index holds for the tail). A key
            // that is ALL dot-dots names a directory above the tree — never an entry.
            const key = posix.relative(normalRoot, resolved);
            return key.endsWith("..") ? null : key;
        }
        if (out[out.length - 1] === "..") return null; // a bare mount run names a directory
        return out.join("/");
    }

    // Folderhood-aware spelling canon ({§fs-namei}): a trailing slash is a folder marker,
    // not a segment — canonicalize the path portion, re-mark. The scheme root ('/' or '')
    // canonicalizes to the EMPTY scope (git's empty-pathspec convention: the root has no
    // name, so scoping to it means everything).
    static canonicalizeSpelling(raw: string, root: string | null): string | null {
        const folder = raw.endsWith("/") || raw.length === 0;
        const trimmed = raw.replace(/\/+$/, "");
        if (folder && (trimmed === "" || trimmed === "/")) return "";
        const key = Namespace.canonicalize(trimmed, root);
        if (key === null) return null;
        return folder ? `${key}/` : key;
    }

    // True when `key` is already canonical — the fixpoint the world-state invariant
    // asserts over every stored file-class pathname: canon(key, root) === key.
    static isCanonical(key: string, root: string | null): boolean {
        return Namespace.canonicalize(key, root) === key;
    }
}
