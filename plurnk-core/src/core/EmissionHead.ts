import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { contentWeight } from "./content-weight.ts";

// {§emission-row} — the one automatic cut left under {§context-fit}: an emission row shows its head,
// about a hundred tokens of curation weight — enough to recognise the turn, never enough to matter to
// the budget. A format rule, not a lever anyone would turn, so it lives here and not on the panel.
export const EMISSION_HEAD_WEIGHT = 100;

export default class EmissionHead {
    // Whole lines while they fit the head; a first line longer than the head is cut inside itself.
    static cut(body: string): { head: string; cut: boolean } {
        if (contentWeight(body) <= EMISSION_HEAD_WEIGHT) return { head: body, cut: false };
        let end = 0;
        for (const line of TextCoordinates.logicalLines(body)) {
            if (contentWeight(body.slice(0, line.end)) > EMISSION_HEAD_WEIGHT) break;
            end = line.end;
        }
        if (end === 0) {
            for (const codePoint of body) {
                const next = end + codePoint.length;
                if (contentWeight(body.slice(0, next)) > EMISSION_HEAD_WEIGHT) break;
                end = next;
            }
        }
        return { head: body.slice(0, end), cut: true };
    }
}
