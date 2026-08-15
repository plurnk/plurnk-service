import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { publint } from "publint";
import { formatMessage, formatMessagePath } from "publint/utils";

const { values } = parseArgs({
    options: {
        only: { type: "string" },
    },
});
const root = JSON.parse(await readFile("package.json", "utf8"));
const directories = values.only === undefined ? root.workspaces : [values.only];
const failures = [];

for (const directory of directories) {
    const { messages, pkg } = await publint({
        pkgDir: directory,
        level: "warning",
        pack: false,
    });
    for (const message of messages) {
        const location = formatMessagePath(message.path);
        const detail = formatMessage(message, pkg, { color: false, reference: true });
        failures.push(`${path.join(directory, "package.json")}${location ? `:${location}` : ""}: ${detail ?? message.code}`);
    }
}

if (failures.length > 0) {
    throw new Error(`publint rejected ${failures.length} package finding(s):\n${failures.join("\n")}`);
}

console.log(`publint GREEN: ${directories.length} workspace package(s)`);
