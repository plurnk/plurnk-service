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

// Lint the byte-exact system/user packet files emitted by a digest. {§packet-lint}
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
