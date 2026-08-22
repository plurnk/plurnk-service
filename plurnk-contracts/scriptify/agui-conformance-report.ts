import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { aguiConformanceReport } from "../src/AguiConformance.ts";

const [discoveryPath, manifestPath, evidenceRoot] = process.argv.slice(2);
if (discoveryPath === undefined || manifestPath === undefined) {
    throw new Error(
        "usage: agui-conformance-report <discovery.json> <client.json> [evidence-root]",
    );
}

const [discovery, conformance] = await Promise.all(
    [discoveryPath, manifestPath].map(async (path) =>
        JSON.parse(await readFile(path, "utf8")) as unknown),
);
const root = evidenceRoot === undefined
    ? resolve(dirname(manifestPath), "..")
    : resolve(evidenceRoot);
const report = aguiConformanceReport(discovery, conformance);
for (const row of report) {
    for (const citation of row.evidence) {
        const path = citation.split(" — ", 1)[0]!;
        try {
            await access(resolve(root, path));
        } catch (cause) {
            throw new Error(
                `${row.kind} '${row.name}' cites missing evidence '${path}'`,
                { cause },
            );
        }
    }
    process.stdout.write(`${JSON.stringify(row)}\n`);
}
