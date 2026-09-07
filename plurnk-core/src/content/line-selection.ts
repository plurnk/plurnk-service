import type { TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";

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

    static region(region: TextRegion, ordinals: readonly number[]): TextRegion | undefined {
        if (ordinals.length === 0 && region.startLine === 1 && region.endLine === 1 && region.startColumn === 1 && region.endColumn === 1) return undefined;
        const at = (line: number, column: number) => line === ordinals.length + 1 && column === 1 && ordinals.length > 0
            ? ordinals.at(-1)! + 1
            : ordinals[line - 1];
        const startLine = at(region.startLine, region.startColumn);
        const endLine = at(region.endLine, region.endColumn);
        if (startLine === undefined || endLine === undefined) {
            throw new RangeError("A projected text region lies outside its source line map.");
        }
        return { ...region, startLine, endLine };
    }
}
