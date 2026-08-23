// A deterministic stand-in for the standard `skills` CLI's subset the Skills
// Functionality family drives: `add <source> --list`, `add <source> --agent
// universal --skill <name> --yes [--global]`, and `remove <name> --yes
// [--global]`. Sources are local directories holding `<name>/SKILL.md` (or
// `skills/<name>/SKILL.md`); installs copy into `<cwd>/.agents/skills` or
// `$HOME/.agents/skills` and maintain `skills-lock.json` beside the root, the
// way the real CLI does. Output mimics the CLI's box-drawing gutter so the
// production listing parser is exercised.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg) => !arg.startsWith("--"));
const option = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? undefined : rest[index + 1];
};
const global = flags.has("--global");
const rootDir = global ? join(homedir(), ".agents", "skills") : join(process.cwd(), ".agents", "skills");
const lockDir = global ? homedir() : process.cwd();
const lockFile = join(lockDir, "skills-lock.json");

const readLock = async () => {
    try {
        return JSON.parse(await readFile(lockFile, "utf8"));
    } catch {
        return { version: 1, skills: {} };
    }
};

const skillsIn = async (source) => {
    const base = resolve(process.cwd(), source);
    if (!(await stat(base).then((info) => info.isDirectory(), () => false))) {
        console.error(`Source not found: ${source}`);
        process.exit(1);
    }
    const candidates = [base, join(base, "skills")];
    const found = [];
    for (const dir of candidates) {
        let entries = [];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries.filter((item) => item.isDirectory())) {
            const file = join(dir, entry.name, "SKILL.md");
            if (!(await stat(file).then((info) => info.isFile(), () => false))) continue;
            const raw = await readFile(file, "utf8");
            const description = /^description:\s*(.+)$/mu.exec(raw)?.[1] ?? "";
            found.push({ name: entry.name, dir: join(dir, entry.name), description });
        }
    }
    return found.toSorted((left, right) => left.name.localeCompare(right.name));
};

if (command === "add" && flags.has("--list")) {
    const found = await skillsIn(positional[0]);
    console.log(`│\n◇  Source: ${positional[0]}\n│\n◇  Found ${found.length} skills\n\n│\n◇  Available Skills\n│`);
    for (const skill of found) console.log(`│    ${skill.name}\n│\n│      ${skill.description}\n│`);
    console.log("└  Use --skill <name> to install specific skills");
    process.exit(0);
}

if (command === "add") {
    const name = option("--skill");
    const found = (await skillsIn(positional[0])).find((skill) => skill.name === name);
    if (found === undefined) {
        console.error(`Skill not found in source: ${name}`);
        process.exit(1);
    }
    await mkdir(rootDir, { recursive: true });
    await cp(found.dir, join(rootDir, name), { recursive: true });
    const lock = await readLock();
    lock.skills[name] = { source: positional[0], sourceType: "local" };
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`◇  Installed 1 skill\n│  ✓ ${name} (copied)\n└  Done!`);
    process.exit(0);
}

if (command === "remove") {
    const name = positional[0];
    await rm(join(rootDir, name), { recursive: true, force: true });
    const lock = await readLock();
    delete lock.skills[name];
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`◆  Successfully removed 1 skill(s)\n└  Done!`);
    process.exit(0);
}

console.error(`unsupported fixture invocation: ${process.argv.slice(2).join(" ")}`);
process.exit(2);
