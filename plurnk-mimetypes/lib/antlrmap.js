import fs from "node:fs/promises";
import path from "node:path";
import Parser from "./Parser.js";

const BUILTIN_EXTENSIONS = Object.freeze({
	".js": "javascript--javascript",
	".mjs": "javascript--javascript",
	".ts": "javascript--typescript",
	".tsx": "javascript--typescript",
	".py": "python--python3",
	".pyw": "python--python3",
	".rs": "rust",
	".go": "golang",
	".java": "java--java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cxx": "cpp",
	".cc": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".kt": "kotlin--kotlin",
	".kts": "kotlin--kotlin",
	".php": "php",
	".lua": "lua",
	".sql": "sql--sqlite",
	".dart": "dart2",
	".scala": "scala",
	".sc": "scala",
	".cbl": "cobol85",
	".cob": "cobol85",
	".cpy": "cobol85",
	".clj": "clojure",
	".cljs": "clojure",
	".cljc": "clojure",
	".edn": "clojure",
	".ex": "elixir",
	".exs": "elixir",
	".zig": "zig",
	".r": "r",
	".R": "r",
	".m": "objc",
	".mm": "objc",
	".v": "verilog",
	".sv": "verilog",
	".vhd": "vhdl",
	".vhdl": "vhdl",
	".tf": "terraform",
	".tfvars": "terraform",
	".f90": "fortran",
	".f95": "fortran",
	".f03": "fortran",
	".f08": "fortran",
	".erl": "erlang",
	".hrl": "erlang",
	".thrift": "thrift",
	".graphql": "graphql",
	".gql": "graphql",
	".pgn": "pgn",
	".awk": "awk",
	".json": "json",
	".jsonc": "json",
	".toml": "toml",
	".dockerfile": "dockerfile",
	Dockerfile: "dockerfile",
});

const BUILTIN_LANGUAGES_DIR = path.resolve(
	import.meta.dirname,
	"..",
	"languages",
);

export default class Antlrmap {
	#parsers = new Map();
	#extensions;
	#customDirs = new Map();

	constructor({ extensions = {} } = {}) {
		this.#extensions = { ...BUILTIN_EXTENSIONS, ...extensions };
	}

	registerLanguage(langId, { dir, extensions }) {
		this.#customDirs.set(langId, dir);
		for (const ext of extensions) {
			this.#extensions[ext] = langId;
		}
	}

	async #getParser(ext) {
		const langId = this.#extensions[ext];
		if (!langId) return null;
		if (this.#parsers.has(langId)) return this.#parsers.get(langId);

		const langDir =
			this.#customDirs.get(langId) ?? path.join(BUILTIN_LANGUAGES_DIR, langId);
		const parser = await Parser.load(langDir);
		this.#parsers.set(langId, parser);
		return parser;
	}

	async mapFile(filePath) {
		const resolved = path.resolve(filePath);
		const ext = path.extname(resolved);
		const parser = await this.#getParser(ext);
		if (!parser) return null;

		let source;
		try {
			source = await fs.readFile(resolved, "utf-8");
		} catch {
			return [];
		}
		return parser.parse(source);
	}

	async mapSource(source, ext) {
		const parser = await this.#getParser(ext);
		if (!parser) return null;

		return parser.parse(source);
	}

	async mapFiles(filePaths, { cwd = process.cwd() } = {}) {
		const results = [];

		for (const filePath of filePaths) {
			const resolved = path.resolve(filePath);
			const symbols = await this.mapFile(resolved);
			if (symbols?.length > 0) {
				results.push({
					file: path.relative(cwd, resolved),
					symbols,
				});
			}
		}

		return results;
	}

	static get extensions() {
		return BUILTIN_EXTENSIONS;
	}

	static get supported() {
		const languages = {};
		for (const [ext, id] of Object.entries(BUILTIN_EXTENSIONS)) {
			languages[id] ??= [];
			languages[id].push(ext);
		}
		return languages;
	}
}
