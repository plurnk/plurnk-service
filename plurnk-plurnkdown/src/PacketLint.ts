import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Plurnkdown from "./Plurnkdown.ts";
import type { Diagnostic } from "./types.ts";

export interface PacketFinding extends Diagnostic {
    file: string;
}

export interface PacketLintResult {
    packets: string[];
    findings: PacketFinding[];
}

// The evaluation instrument: lint real emitted packets, not fixtures. A digest dir holds
// packetNNN.{system,user}.md — byte-exact what the model saw (Engine and digest both render
// through one PacketWire). Produce it with `plurnk-core/bin/digest.ts <run.db> <dir>`.
export default class PacketLint {
    static lintDir(dir: string): PacketLintResult {
        const linter = new Plurnkdown();
        const packets = readdirSync(dir).filter((f) => /^packet\d+\.(system|user)\.md$/.test(f)).sort();
        const findings: PacketFinding[] = [];
        for (const file of packets) {
            for (const d of linter.lint(readFileSync(join(dir, file), "utf8"))) findings.push({ file, ...d });
        }
        return { packets, findings };
    }
}
