import type { TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";

// {§log-readable-projection} — physical coordinates survive sparse selection.
export default class LineSelection {
    static retain(content: string, selected: readonly number[], startLine = 1): { content: string; ordinals: number[] } {
        const allowed = new Set(selected);
        const lines = TextCoordinates.logicalLines(content);
        const kept = lines.flatMap((line, index) => allowed.has(startLine + index)
            ? [{ line, ordinal: startLine + index }]
            : []);
        return {
            content: kept.map(({ line }) => content.slice(line.start, line.end)).join(""),
            ordinals: kept.map(({ ordinal }) => ordinal),
        };
    }

    static regions(region: TextRegion, ordinals: readonly number[]): TextRegion[] {
        if (ordinals.length === 0 && region.startLine === 1 && region.endLine === 1 && region.startColumn === 1 && region.endColumn === 1) return [];
        const at = (line: number, column: number) => line === ordinals.length + 1 && column === 1 && ordinals.length > 0
            ? ordinals.at(-1)! + 1
            : ordinals[line - 1];
        const startLine = at(region.startLine, region.startColumn);
        const endLine = at(region.endLine, region.endColumn);
        if (startLine === undefined || endLine === undefined) {
            throw new RangeError("A projected text region lies outside its source line map.");
        }
        const fragments: TextRegion[] = [];
        let start = { startLine, startColumn: region.startColumn };
        for (let line = region.startLine; line < region.endLine; line++) {
            const next = ordinals[line];
            const after = ordinals[line - 1]! + 1;
            if (line + 1 === region.endLine && region.endColumn === 1) {
                fragments.push({ ...start, endLine: after, endColumn: 1 });
                return fragments;
            }
            if (next !== after) {
                fragments.push({ ...start, endLine: after, endColumn: 1 });
                start = { startLine: next!, startColumn: 1 };
            }
        }
        fragments.push({ ...start, endLine, endColumn: region.endColumn });
        return fragments;
    }

    static evidence(matches: readonly MatchEvidence[], ordinals: readonly number[]): MatchEvidence[] {
        return matches.flatMap(({ region, enclosingRegion, ...evidence }) => {
            if (region !== undefined) return LineSelection.regions(region, ordinals).map((part) => ({ ...evidence, region: part }));
            if (enclosingRegion !== undefined) return LineSelection.regions(enclosingRegion, ordinals).map((part) => ({ ...evidence, enclosingRegion: part }));
            return [evidence];
        });
    }
}
