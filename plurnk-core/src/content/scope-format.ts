import type { LineMarker, RangeExtent, TextRegion } from "@plurnk/plurnk-contracts";

// {§packet-extent-metadata} — display only; selection always uses the typed facts.
export default class ScopeFormat {
    static marker({ marks }: LineMarker): string {
        return `<${marks.join(",")}>`;
    }

    static lines(first: number, last: number): string {
        return ScopeFormat.marker({ marks: first === last ? [first] : [first, last] });
    }

    static region(region: TextRegion): string {
        return ScopeFormat.marker({ marks: [region.startLine, region.startColumn, region.endLine, region.endColumn] });
    }

    static count(unit: RangeExtent["unit"], total: number): string {
        const name = unit === "matchLocation" ? "match location" : unit;
        return `${total} ${name}${total === 1 ? "" : "s"}`;
    }

    static range(range: RangeExtent, sparse = false): string {
        const extent = ScopeFormat.count(range.unit, range.total);
        if (range.total === 0) return extent;
        if (range.returned === undefined) return `none of ${extent}`;
        const [first, last] = range.returned;
        if (!sparse && first === 1 && last === range.total) return extent;
        return `${ScopeFormat.lines(first, last)} of ${extent}`;
    }
}
