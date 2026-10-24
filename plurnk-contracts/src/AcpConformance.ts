import Validator from "./Validator.ts";
import type { Dimensions } from "./types.generated.ts";

export interface AcpConformanceRow {
    readonly kind: "action" | "notification";
    readonly name: string;
    readonly posture: "native" | "generic" | "unsupported";
    readonly dimensions: Dimensions;
    readonly evidence: readonly string[];
    readonly reason?: string;
}

export const acpConformanceReport = (
    discoveryValue: unknown,
    conformanceValue: unknown,
): AcpConformanceRow[] => {
    const conformance = Validator.assertAcpClientConformance(
        discoveryValue,
        conformanceValue,
    );
    const rows = (
        kind: "actions" | "notifications",
        label: AcpConformanceRow["kind"],
    ): AcpConformanceRow[] => Object.entries(conformance[kind])
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
