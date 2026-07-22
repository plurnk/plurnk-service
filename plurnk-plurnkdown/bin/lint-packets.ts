#!/usr/bin/env node

// CLI for PacketLint (src/PacketLint.ts): lint the emitted packets in a digest dir against
// the plurnkdown house style. Produce the dir with `plurnk-core/bin/digest.ts <run.db> <dir>`,
// then `npm run dev:lint-packets <dir>`.
import PacketLint from "../src/PacketLint.ts";

if (import.meta.main) {
    const dir = process.argv[2];
    if (dir === undefined) {
        process.stderr.write("usage: lint-packets <digest-dir>\n");
        process.exit(1);
    }
    const { packets, findings } = PacketLint.lintDir(dir);
    const byRule = new Map<string, number>();
    for (const f of findings) byRule.set(`${f.rule}/${f.severity}`, (byRule.get(`${f.rule}/${f.severity}`) ?? 0) + 1);
    const clean = packets.filter((p) => !findings.some((f) => f.file === p)).length;
    process.stdout.write(`packets linted: ${packets.length}  (clean: ${clean})\n`);
    process.stdout.write(`total deviations: ${findings.length}\n`);
    for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) process.stdout.write(`  ${rule}: ${n}\n`);
    for (const f of findings) process.stdout.write(`  ${f.file}:${f.line} [${f.rule}/${f.severity}] ${f.message}\n`);
}
