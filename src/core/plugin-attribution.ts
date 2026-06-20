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
// The ONE semantic the service enforces is the reservation, GROUNDED IN NPM SCOPE: a
// package may carry an `@plurnk/` attribution only if it is itself `@plurnk/`-scoped. npm
// enforces scope ownership at publish, so a package whose own name is `@plurnk/…` is a REAL
// first-party signal — not a self-claim. A non-`@plurnk/` package claiming `@plurnk/` fails
// hard. This is an honest-author guardrail + a day-one land-grab on the creator namespace,
// NOT anti-spoofing security: an open-source service can be forked and patched, so
// authoritative ownership is enforced backend-side (model.plurnk.ai validates the bearer
// account owns the claimed identity). The client-side check just keeps honest authors honest.
//
// Deliberately NOT here (the rigor — deferred, #249): grounding the wire's VALUE in real
// per-turn value flow (the dispatched code AND consumed content of THIS turn — the current
// value is the active-plugin set as a placeholder), token-weighting, and the client id.

import { createRequire } from "node:module";

const RESERVED_PREFIX = "@plurnk/";

export default class PluginAttribution {
    // Normalize a raw `plurnk.attribution` value to a tag list AND enforce the reservation.
    // Pure (no I/O) so the contract is unit-testable. A plugin claiming the reserved
    // namespace is a fail-hard contract violation, not a silently-dropped tag.
    static normalize(raw: unknown, packageName: string): string[] {
        if (raw === undefined || raw === null) return [];
        const tags = Array.isArray(raw) ? raw : [raw];
        // Verifiably first-party iff the package's OWN name is @plurnk/-scoped — npm enforces
        // scope ownership at publish, so this is a real signal, not a self-asserted flag.
        const firstParty = packageName.startsWith(RESERVED_PREFIX);
        const out: string[] = [];
        for (const tag of tags) {
            if (typeof tag !== "string" || tag.length === 0) {
                throw new Error(`plugin '${packageName}': plurnk.attribution must be a non-empty string or string[]`);
            }
            if (tag.startsWith(RESERVED_PREFIX) && !firstParty) {
                throw new Error(`plugin '${packageName}': the '${RESERVED_PREFIX}' attribution namespace is reserved for first-party (${RESERVED_PREFIX}-scoped) packages — '${packageName}' cannot claim '${tag}'. Authoritative ownership is enforced backend-side at model.plurnk.ai; this is an honest-author guardrail grounded in npm scope.`);
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
