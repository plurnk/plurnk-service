import { basename, extname } from "node:path";
import type { DetectInput, Registry } from "./types.ts";

// Resolve a mimetype string from any combination of path / explicit extension /
// caller hint / raw content. Resolution priority (highest wins):
//
//   1. hint     — caller asserts a mimetype directly
//   2. filename — path's basename matches a registered special filename
//                 (Dockerfile, Makefile, etc.)
//   3. extension — explicit `ext` arg, or extname() of `path`
//   4. content   — magic-byte sniffing (not yet implemented; future hook)
//
// Returns the matched mimetype or null when no rule fires.
export function detect(input: DetectInput, registry: Registry): string | null {
    if (input.hint !== undefined && input.hint !== "") {
        return input.hint;
    }

    if (input.path !== undefined && input.path !== "") {
        const name = basename(input.path);
        const match = registry.byFilename.get(name);
        if (match !== undefined) return match;
    }

    const ext = pickExt(input);
    if (ext !== undefined) {
        const match = registry.byExtension.get(normalizeExt(ext));
        if (match !== undefined) return match;
    }

    // Content sniffing is a future hook — no magic-byte table yet.
    return null;
}

// Build an empty registry. Useful for tests and as a starting point before
// discover() populates real entries.
export function emptyRegistry(): Registry {
    return {
        byExtension: new Map<string, string>(),
        byFilename: new Map<string, string>(),
    };
}

function pickExt(input: DetectInput): string | undefined {
    if (input.ext !== undefined && input.ext !== "") return input.ext;
    if (input.path !== undefined && input.path !== "") {
        const fromPath = extname(input.path);
        if (fromPath !== "") return fromPath;
    }
    return undefined;
}

function normalizeExt(ext: string): string {
    const lower = ext.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
}
