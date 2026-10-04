import { parsePath } from "@plurnk/plurnk-parser";
import { PlurnkParseError, type KillStatement, type PlurnkStatement, type ReadStatement } from "@plurnk/plurnk-contracts";

const EXPLICIT_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

const splitTopLevel = (raw: string): string[] => {
    const members: string[] = [];
    let memberStart = 0;
    let braceDepth = 0;

    for (let index = 0; index < raw.length; index++) {
        const char = raw[index]!;
        if (char === "{") {
            braceDepth++;
            continue;
        }
        if (char === "}" && braceDepth > 0) {
            braceDepth--;
            continue;
        }
        if (braceDepth > 0 || (char !== "," && !/\s/u.test(char))) continue;

        const member = raw.slice(memberStart, index).trim();
        if (member.length > 0) members.push(member);
        while (index + 1 < raw.length && (raw[index + 1] === "," || /\s/u.test(raw[index + 1]!))) index++;
        memberStart = index + 1;
    }

    const finalMember = raw.slice(memberStart).trim();
    if (finalMember.length > 0) members.push(finalMember);
    return members;
};

// {§safe-uri-target-groups} — the heading's slot group ({§target-group}): one member per slot, any
// target kind, each with the scope, metadata and matcher its own slot carried; the heading's naked
// pattern is every member's; a distilling body lands once, with the first member.
const expandSlotGroup = (statement: ReadStatement | KillStatement): PlurnkStatement[] => {
    const { group, ...single } = statement;
    if (group === undefined) return [statement];
    const shared = group[0].matcher === null ? statement.matcher : null;
    return group.map((member, index) => ({
        ...single,
        target: member.target,
        lineMarker: member.lineMarker,
        metadata: member.metadata,
        matcher: member.matcher ?? shared,
        ...(index === 0 || statement.op !== "KILL" ? {} : { body: null }),
    }) as PlurnkStatement);
};

// {§safe-uri-target-groups} — one slot whose text is several explicit URIs: an admission tolerance,
// not a second path grammar. The authored statement remains in the forensic turnOps source; only
// ordinary dispatch receives one clone per independently valid URI, the selection shared.
const expandSafeUriGroup = (statement: ReadStatement | KillStatement): PlurnkStatement[] => {
    if (statement.target === null) return [statement];
    const members = splitTopLevel(statement.target.raw);
    if (members.length < 2 || members.some((member) => !EXPLICIT_URI.test(member))) return [statement];

    try {
        const targets = members.map((member) => parsePath(member));
        if (targets.some((target) => target?.kind !== "url")) return [statement];
        return targets.map((target) => ({ ...statement, target: target! }));
    } catch (error) {
        if (error instanceof PlurnkParseError) return [statement];
        throw error;
    }
};

// {§safe-uri-target-groups} — a READ or KILL target group becomes one ordinary statement per member,
// in authored order; every other statement passes through whole.
export const expandTargetGroup = (statement: PlurnkStatement): PlurnkStatement[] => {
    if (statement.op !== "READ" && statement.op !== "KILL") return [statement];
    return statement.group === undefined ? expandSafeUriGroup(statement) : expandSlotGroup(statement);
};
