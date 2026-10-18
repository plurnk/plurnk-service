import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// {§candidate-pinned-runtime} — a candidate runs its daemon and exports its digest from a copy of
// the service build taken at launch. The checkout's `dist` is shared: a concurrent candidate's
// build, or a developer's, replaces it mid-run, and a run must finish on the code it started with.
// Each workspace keeps its package projection (`files`); third-party dependencies are linked, not
// copied, and `@plurnk/*` resolves to the pinned workspaces.
export const pinRuntime = (root, destination) => {
    const { workspaces } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const pinned = new Map();
    for (const workspace of workspaces) {
        const source = resolve(root, workspace);
        const manifest = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
        const target = resolve(destination, workspace);
        mkdirSync(target, { recursive: true });
        cpSync(resolve(source, "package.json"), resolve(target, "package.json"));
        const tops = new Set(manifest.files.map((entry) => entry.split("/")[0]));
        for (const top of tops) {
            if (!existsSync(resolve(source, top))) continue;
            cpSync(resolve(source, top), resolve(target, top), { recursive: true });
        }
        if (existsSync(resolve(source, "node_modules"))) symlinkSync(resolve(source, "node_modules"), resolve(target, "node_modules"));
        pinned.set(manifest.name, target);
    }
    const modules = resolve(root, "node_modules");
    const pinnedModules = resolve(destination, "node_modules");
    mkdirSync(pinnedModules, { recursive: true });
    for (const entry of readdirSync(modules)) {
        if (!entry.startsWith("@")) {
            symlinkSync(resolve(modules, entry), resolve(pinnedModules, entry));
            continue;
        }
        mkdirSync(resolve(pinnedModules, entry));
        for (const name of readdirSync(resolve(modules, entry))) {
            symlinkSync(pinned.get(`${entry}/${name}`) ?? resolve(modules, entry, name), resolve(pinnedModules, entry, name));
        }
    }
    writeFileSync(resolve(destination, "package.json"), readFileSync(resolve(root, "package.json")));
    return destination;
};
