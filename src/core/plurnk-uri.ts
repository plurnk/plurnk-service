// The plurnk:// addressing convention. A namespace lives in the URL authority slot
// (plurnk://docs/x.md, plurnk://prompt/<loop>), but the canonical STORAGE key is the full
// path with the namespace folded in (/docs/x.md) — entries are keyed by (scope, scheme,
// pathname) with no authority column, so the authority MUST fold into the path.
//
//   fold   = parse-side: authority → path. Generic; a no-op when there's no authority.
//   render = the inverse: path → model-facing URI. A multi-segment plurnk path promotes its
//            first segment to the authority slot; a single-segment singleton (manifest.json,
//            an alias doc) stays empty-authority root. Non-plurnk schemes are untouched.
//
// A web host (http://en.wikipedia.org/…) is NOT a namespace and never folds — callers that
// see other schemes gate the fold on scheme === "plurnk"; the entry layer only ever sees
// empty-authority schemes, so it folds unconditionally (a no-op there).

export function foldAuthorityIntoPath(hostname: string | null, pathname: string): string {
    return hostname ? `/${hostname}${pathname}` : pathname;
}

export function renderAddress(scheme: string, pathname: string): string {
    if (scheme === "plurnk" && pathname.split("/").filter((s) => s.length > 0).length >= 2) {
        return `plurnk://${pathname.replace(/^\//, "")}`;
    }
    return `${scheme}://${pathname}`;
}
