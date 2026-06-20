// #249 — plugin attribution: an ergonomic, opaque tag a plugin declares in its
// package.json so the creators behind it can be credited when the plugin is active.
//
//   { "plurnk": { "attribution": "@acme/widgets" } }              // one tag
//   { "plurnk": { "attribution": ["npm:jane", "@acme/widgets"] } } // several
//
// The service does NOT interpret the tags — they ride the `attributions[]` wire to the
// plurnk provider, which forwards them as a first-party header (every other provider drops
// them, so first-party metadata stays first-party by construction). An npm-style handle is
// the natural form; richer creator identities smuggle under the SAME namespace later
// (e.g. `@plurnk/creators/johnny-cash`).
//
// The ONE semantic the service enforces is the reservation: `@plurnk/` is reserved for
// first-party creator identities the daemon controls, and a plugin claiming it fails hard —
// a day-one land-grab so the creator namespace can't be squatted before it's lit up.
//
// Deliberately NOT here (the "how it actually works" — deferred, #249): grounding
// attribution in real per-turn dispatch, token-weighting by value contributed, the
// content/authorship door (entry-level attribution), and the self-identified client id.

import { createRequire } from "node:module";

const RESERVED_PREFIX = "@plurnk/";

export default class PluginAttribution {
    // Normalize a raw `plurnk.attribution` value to a tag list AND enforce the reservation.
    // Pure (no I/O) so the contract is unit-testable. A plugin claiming the reserved
    // namespace is a fail-hard contract violation, not a silently-dropped tag.
    static normalize(raw: unknown, packageName: string): string[] {
        if (raw === undefined || raw === null) return [];
        const tags = Array.isArray(raw) ? raw : [raw];
        const out: string[] = [];
        for (const tag of tags) {
            if (typeof tag !== "string" || tag.length === 0) {
                throw new Error(`plugin '${packageName}': plurnk.attribution must be a non-empty string or string[]`);
            }
            if (tag.startsWith(RESERVED_PREFIX)) {
                throw new Error(`plugin '${packageName}': the '${RESERVED_PREFIX}' attribution namespace is reserved for first-party creators and cannot be claimed by a plugin (got '${tag}')`);
            }
            out.push(tag);
        }
        return out;
    }

    // Read + normalize a package's declared attribution from its package.json. A package
    // whose manifest isn't resolvable (strict `exports` with no `./package.json`) yields no
    // readable tag — skipped, not crashed; native surfacing in each framework's discover()
    // is the durable path (delegate upstream), tracked separately.
    static read(packageName: string): string[] {
        let manifest: { plurnk?: { attribution?: unknown } };
        try {
            manifest = createRequire(import.meta.url)(`${packageName}/package.json`) as typeof manifest;
        } catch {
            return [];
        }
        return PluginAttribution.normalize(manifest?.plurnk?.attribution, packageName);
    }
}
