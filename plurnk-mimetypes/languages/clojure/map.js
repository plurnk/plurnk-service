import ClojureVisitor from "./generated/ClojureVisitor.js";

const DEF_KINDS = Object.freeze({
	defn: "function",
	"defn-": "function",
	defmacro: "function",
	def: "variable",
	defonce: "variable",
	ns: "module",
	defprotocol: "interface",
	defrecord: "class",
	deftype: "class",
});

class SymbolExtractor extends ClojureVisitor {
	#symbols = [];

	get symbols() {
		return this.#symbols;
	}

	#add(kind, name, ctx, params) {
		const symbol = {
			name,
			kind,
			line: ctx.start.line,
			endLine: ctx.stop?.line ?? ctx.start.line,
		};
		if (params) symbol.params = params;
		this.#symbols.push(symbol);
	}

	#extractParams(forms) {
		if (!forms) return [];
		const children = forms.form?.() ?? [];
		for (const child of children) {
			const vec = child.vector?.();
			if (!vec) continue;
			const innerForms = vec.forms?.();
			if (!innerForms) return [];
			const params = [];
			const elems = innerForms.form?.() ?? [];
			for (const elem of elems) {
				const text = elem.getText();
				if (text === "&") continue;
				params.push(text);
			}
			return params;
		}
		return [];
	}

	visitList_(ctx) {
		const forms = ctx.forms?.();
		if (!forms) return null;
		const children = forms.form?.() ?? [];
		if (children.length < 2) return null;

		const firstForm = children[0];
		const head = firstForm.getText();
		const kind = DEF_KINDS[head];
		if (!kind) return null;

		const nameForm = children[1];
		const name = nameForm.getText();
		if (!name) return null;

		const params = kind === "function" ? this.#extractParams(forms) : undefined;
		this.#add(kind, name, ctx, params);
		return null;
	}
}

export default class ClojureMap {
	static status = "done";
	static entryRule = "file_";
	static extensions = [".clj", ".cljs", ".cljc", ".edn"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
