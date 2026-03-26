import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const GRAMMARS_DIR = path.join(ROOT, "vendor", "grammars-v4");
const LANGUAGES_DIR = path.join(ROOT, "languages");
const MANIFEST_PATH = path.join(LANGUAGES_DIR, "manifest.json");

const SKIP_DIRS = new Set([
	".github",
	".config",
	".claude",
	"_scripts",
	".git",
]);

async function isDirectory(fullPath) {
	const stat = await fs.stat(fullPath).catch(() => null);
	return stat?.isDirectory() ?? false;
}

async function findG4Files(dir) {
	const entries = await fs.readdir(dir);
	return entries.filter((e) => e.endsWith(".g4"));
}

async function discoverGrammars() {
	const topLevel = await fs.readdir(GRAMMARS_DIR);
	const grammars = [];

	for (const name of topLevel) {
		if (SKIP_DIRS.has(name)) continue;
		const fullPath = path.join(GRAMMARS_DIR, name);
		if (!(await isDirectory(fullPath))) continue;

		const g4Files = await findG4Files(fullPath);

		if (g4Files.length > 0) {
			// Leaf grammar — g4 files directly in this folder
			grammars.push({
				id: name,
				grammarDir: path.relative(ROOT, fullPath),
				g4Files,
				status: "todo",
			});
			continue;
		}

		// Check for nested grammars (e.g., sql/postgresql/)
		const children = await fs.readdir(fullPath);
		for (const child of children) {
			const childPath = path.join(fullPath, child);
			if (!(await isDirectory(childPath))) continue;

			const childG4 = await findG4Files(childPath);
			if (childG4.length > 0) {
				grammars.push({
					id: `${name}--${child}`,
					grammarDir: path.relative(ROOT, childPath),
					g4Files: childG4,
					status: "todo",
				});
			}
		}
	}

	grammars.sort((a, b) => a.id.localeCompare(b.id));
	return grammars;
}

function stubMapJs(grammar) {
	const g4List = grammar.g4Files.join(", ");
	return `// TODO: implement symbol mapping for ${grammar.id}
// Grammar files: ${g4List}
export default class Map {
  static status = "todo";

  /** @param {import("antlr4").ParserRuleContext} tree */
  static extract(tree) {
    return [];
  }
}
`;
}

function stubPackageJson(grammar) {
	return JSON.stringify(
		{
			name: `@antlrmap/${grammar.id}`,
			version: "0.0.1",
			type: "module",
			private: true,
			files: ["map.js", "generated/"],
			peerDependencies: {
				antlr4: "*",
			},
			scripts: {
				build: `node ../../scripts/compile.js ${grammar.id}`,
				test: "node --test",
			},
		},
		null,
		2,
	);
}

async function scaffold() {
	await fs.mkdir(LANGUAGES_DIR, { recursive: true });

	const grammars = await discoverGrammars();

	// Load existing manifest to preserve status of already-scaffolded grammars
	const existing = new Map();
	try {
		const raw = await fs.readFile(MANIFEST_PATH, "utf-8");
		for (const entry of JSON.parse(raw)) {
			existing.set(entry.id, entry);
		}
	} catch {
		// No existing manifest
	}

	// Merge: preserve status from existing entries
	const manifest = grammars.map((g) => {
		const prev = existing.get(g.id);
		if (prev) return { ...g, status: prev.status };
		return g;
	});

	// Write manifest
	await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

	// Generate workspace stubs
	let created = 0;
	let skipped = 0;

	for (const grammar of manifest) {
		const langDir = path.join(LANGUAGES_DIR, grammar.id);
		await fs.mkdir(langDir, { recursive: true });

		const mapPath = path.join(langDir, "map.js");
		const pkgPath = path.join(langDir, "package.json");

		const mapExists = await fs.access(mapPath).then(
			() => true,
			() => false,
		);
		const pkgExists = await fs.access(pkgPath).then(
			() => true,
			() => false,
		);

		if (!mapExists) {
			await fs.writeFile(mapPath, stubMapJs(grammar));
		}

		if (!pkgExists) {
			await fs.writeFile(pkgPath, `${stubPackageJson(grammar)}\n`);
		}

		if (!mapExists || !pkgExists) created++;
		else skipped++;
	}

	console.log(`Manifest: ${manifest.length} grammars`);
	console.log(`Created: ${created} workspace stubs`);
	console.log(`Skipped: ${skipped} (already exist)`);
}

scaffold();
