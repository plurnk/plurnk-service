// Path-extension mimetype resolver for entry schemes ({§path-extension-mimetype}):
// a path suffix (`.json`, `.md`, `.txt`, etc.) declares the
// mimetype; an absent suffix defers to the scheme default.
//
// Plurnk-service implements this uniformly across entry schemes: a
// pathname's extension drives the effective mimetype (via the sibling
// Mimetypes detect service), and the scheme manifest's channel default
// is the fallback when no extension is present.
//
// This makes structural ops (`<L>` item-index, matcher dialect dispatch)
// fire correctly without content-sniffing: a model writing JSON to
// `notes:///users.json` opts into JSON treatment via the `.json` suffix,
// while `notes:///scratch` (no suffix) stays at that scheme's default of
// `text/markdown`.
//
// Consistent across:
//   - notes:///users.json     → application/json
//   - notes:///scratch.md     → text/markdown
//   - notes:///config.yaml    → application/yaml
//   - notes:///scratch        → scheme default

import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import MimetypeClassifier from "./MimetypeClassifier.ts";

export default class PathMimetype {
    // Extract the suffix (everything after the last dot in the last segment)
    // from a pathname. Empty if no dot in the last segment.
    static extractExtension(pathname: string): string {
        const lastSlash = pathname.lastIndexOf("/");
        const lastSegment = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
        const lastDot = lastSegment.lastIndexOf(".");
        if (lastDot <= 0) return "";  // leading-dot files (".env") aren't an extension
        return lastSegment.slice(lastDot);  // includes the leading "."
    }

    // Resolve a pathname → effective mimetype.
    // 1. If the pathname has an extension, query Mimetypes.detect({ ext })
    //    and use what comes back (normalized via the text-primitive rule —
    //    text/plain → text/markdown).
    // 2. Otherwise (no extension or no Mimetypes service), fall back to
    //    `schemeDefault` (typically the scheme manifest's channel default).
    static async resolve(
        pathname: string,
        schemeDefault: string,
        mimetypes: Mimetypes | undefined,
    ): Promise<string> {
        const ext = PathMimetype.extractExtension(pathname);
        if (ext.length > 0 && mimetypes !== undefined) {
            const detected = await mimetypes.detect({ ext });
            if (detected !== null) return MimetypeClassifier.normalizeAutoText(detected);
        }
        return schemeDefault;
    }
}
