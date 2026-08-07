import path from "node:path";

export const CONFIG_SOURCE_CLASSES = [
    "package .env.defaults floor",
    "~/.plurnk/.env",
    "./.env",
    "explicit env file",
    "process environment",
    "CLI flag",
];

export const configDeclarations = (files) => {
    const declarations = new Map();
    const claim = (key, owner, declaration) => {
        const prior = declarations.get(key);
        if (prior !== undefined && prior.owner !== owner) {
            throw new Error(`config inventory collision: ${key} is declared by both ${prior.owner} and ${owner}`);
        }
        if (prior?.declaration === "default" || declaration === "optional" && prior !== undefined) return;
        declarations.set(key, { owner, declaration });
    };

    for (const { owner, parsed, text } of files) {
        for (const key of Object.keys(parsed)) claim(key, owner, "default");
        for (const line of text.split(/\r?\n/)) {
            // Optional declarations use the conventional commented assignment
            // spelling (`# KEY=value`). Prose such as `# Empty = ...` is not a
            // declaration and must not mint a fake configuration key.
            const match = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
            if (match !== null) claim(match[1], owner, "optional");
        }
    }
    return declarations;
};

export const formatConfigInventory = (declarations, env) => {
    const rows = [
        `SOURCE PRECEDENCE (LOW→HIGH)\t${CONFIG_SOURCE_CLASSES.join(" < ")}`,
        "KEY\tOWNER\tDECLARATION\tCOMMAND SOURCE",
    ];
    for (const [key, { owner, declaration }] of [...declarations].toSorted(([a], [b]) => a.localeCompare(b))) {
        const source = env[key] !== undefined
            ? "process environment"
            : declaration === "default"
                ? "package default"
                : "unset";
        rows.push(`${key}\t${owner}\t${declaration}\t${source}`);
    }
    return `${rows.join("\n")}\n`;
};

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const serviceRoot = path.join(root, "plurnk-core");
    const nodeModules = path.join(root, "node_modules");
    const { default: EnvDefaults } = await import("../plurnk-core/src/core/env-defaults.ts");
    const files = await EnvDefaults.collect(serviceRoot, nodeModules);
    EnvDefaults.merge(files);
    process.stdout.write(formatConfigInventory(configDeclarations(files), process.env));
}
