import Validator from "./Validator.ts";
import type { Dimensions } from "./types.generated.ts";

export interface AguiConformanceRow {
    readonly kind: "action" | "notification";
    readonly name: string;
    readonly posture: "native" | "generic" | "unsupported";
    readonly dimensions: Dimensions;
    readonly evidence: readonly string[];
    readonly reason?: string;
}

export const aguiConformanceReport = (
    discoveryValue: unknown,
    conformanceValue: unknown,
): AguiConformanceRow[] => {
    const conformance = Validator.assertAguiClientConformance(
        discoveryValue,
        conformanceValue,
    );
    const rows = <Kind extends "actions" | "notifications">(
        kind: Kind,
        label: AguiConformanceRow["kind"],
    ): AguiConformanceRow[] => Object.entries(conformance[kind])
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, disposition]) => ({
            kind: label,
            name,
            posture: disposition.posture,
            dimensions: disposition.dimensions,
            evidence: disposition.evidence,
            ...(disposition.posture === "unsupported" ? { reason: disposition.reason } : {}),
        }));
    return [...rows("actions", "action"), ...rows("notifications", "notification")];
};
