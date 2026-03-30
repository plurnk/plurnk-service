import fs from "node:fs/promises";
import path from "node:path";
import antlr4 from "antlr4";

export default class Parser {
	#lexerClass;
	#parserClass;
	#mapClass;
	#entryRule;

	constructor({ lexerClass, parserClass, mapClass, entryRule = "program" }) {
		this.#lexerClass = lexerClass;
		this.#parserClass = parserClass;
		this.#mapClass = mapClass;
		this.#entryRule = entryRule;
	}

	parse(source) {
		const chars = new antlr4.InputStream(source);
		const lexer = new this.#lexerClass(chars);
		const tokens = new antlr4.CommonTokenStream(lexer);
		const parser = new this.#parserClass(tokens);
		parser.removeErrorListeners();
		const tree = parser[this.#entryRule]();
		const flat = this.#mapClass.extract(tree);
		return nestSymbols(flat);
	}

	static nestSymbols = nestSymbols;

	static async load(languageDir) {
		const generated = path.join(languageDir, "generated");
		const { default: MapClass } = await import(
			path.join(languageDir, "map.js")
		);
		if (MapClass.status === "todo") return null;

		const files = await fs.readdir(generated);
		const lexerFile = files.find((f) => f.endsWith("Lexer.js"));
		const parserFile = files.find(
			(f) => f.endsWith("Parser.js") && !f.includes("Base"),
		);
		if (!lexerFile || !parserFile)
			throw new Error(`Missing Lexer/Parser in ${generated}`);

		const { default: LexerClass } = await import(
			path.join(generated, lexerFile)
		);
		const { default: ParserClass } = await import(
			path.join(generated, parserFile)
		);

		return new Parser({
			lexerClass: LexerClass,
			parserClass: ParserClass,
			mapClass: MapClass,
			entryRule: MapClass.entryRule ?? "program",
		});
	}
}

function nestSymbols(flat) {
	const sorted = flat.toSorted(
		(a, b) => a.line - b.line || b.endLine - a.endLine,
	);
	const roots = [];
	const stack = [];

	for (const sym of sorted) {
		while (stack.length > 0 && stack[stack.length - 1].endLine < sym.line) {
			stack.pop();
		}

		if (stack.length > 0) {
			const parent = stack[stack.length - 1];
			parent.children ??= [];
			parent.children.push(sym);
		} else {
			roots.push(sym);
		}

		if (sym.endLine > sym.line) {
			stack.push(sym);
		}
	}

	return roots;
}
