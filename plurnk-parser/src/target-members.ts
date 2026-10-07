import { PlurnkParseError, type ParsedPath } from "@plurnk/plurnk-contracts";

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

// {§safe-uri-target-groups}: only a list of independently valid explicit URIs is unambiguous.
export const targetMembers = (target: ParsedPath, parsePath: (raw: string) => ParsedPath | null): ParsedPath[] => {
    const members = splitTopLevel(target.raw);
    if (members.length < 2 || members.some((member) => !EXPLICIT_URI.test(member))) return [target];

    try {
        const targets = members.map((member) => parsePath(member));
        if (targets.some((member) => member?.kind !== "url")) return [target];
        return targets as ParsedPath[];
    } catch (error) {
        if (error instanceof PlurnkParseError) return [target];
        throw error;
    }
};
