import type { FunctionalityFamilyHandle } from "@plurnk/plurnk-contracts";
import { FunctionalityResourceFacet } from "@plurnk/plurnk-schemes";

const OWNER = "schedule:resource";
const ALIAS_PATH = /^\/(?:rules\/)?([^/]+)$/u;

const aliasFromPath = (pathname: string): string | null => {
    if (pathname === "/rules" || pathname === "/outputs" || pathname.startsWith("/outputs/")) return null;
    const match = ALIAS_PATH.exec(pathname);
    if (match === null) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
};

// {§schedule-family} The rule resources, `schedule:///rules/<alias>` (or `schedule:///<alias>`).
export default class ScheduleResources extends FunctionalityResourceFacet {
    constructor(handle: () => FunctionalityFamilyHandle | null) {
        super({
            owner: OWNER,
            scheme: "schedule",
            handle,
            manifest: {
                writableBy: ["model", "client", "_plurnk"],
            },
            claims: (pathname) => /^\/rules(?:\/|$)/u.test(pathname) || aliasFromPath(pathname) !== null,
            aliasFromPathname: aliasFromPath,
            pathnameOfAlias: (alias) => `/rules/${encodeURIComponent(alias)}`,
            authorityDetail: "Schedule resources use an empty authority.",
            notFoundDetail: "The schedule resource does not exist.",
            wholeEditDetail: "One edit sets one schedule definition, whole.",
            wholeKillDetail: "kill retires the whole schedule definition.",
            toEditInvocation: FunctionalityResourceFacet.jsonReplaceInvocation(
                OWNER,
                "The schedule definition body must be a JSON object.",
            ),
        });
    }
}
