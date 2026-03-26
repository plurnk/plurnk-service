import LuaParserVisitor from "./generated/LuaParserVisitor.js";

class SymbolExtractor extends LuaParserVisitor {
	#symbols = [];
	#inBody = false;

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

	#extractParams(funcbody) {
		if (!funcbody) return [];
		const parlist = funcbody.parlist?.();
		if (!parlist) return [];
		const params = [];
		const namelist = parlist.namelist?.();
		if (namelist) {
			const names = namelist.NAME?.() ?? [];
			for (const n of names) params.push(n.getText());
		}
		const hasVararg = parlist.getText().includes("...");
		if (hasVararg) params.push("...");
		return params;
	}

	// Scope boundary: block inside funcbody
	visitFuncbody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitStat(ctx) {
		if (this.#inBody) return null;
		// 'function' funcname funcbody
		const funcname = ctx.funcname?.();
		const funcbody = ctx.funcbody?.();
		if (funcname && funcbody) {
			const names = funcname.NAME?.() ?? [];
			const fullName = names.map((n) => n.getText()).join(".");
			if (fullName) {
				const params = this.#extractParams(funcbody);
				this.#add("function", fullName, ctx, params);
			}
			return this.visitChildren(ctx);
		}
		// 'local' 'function' NAME funcbody
		const nameToken = ctx.NAME?.();
		if (nameToken && funcbody) {
			const params = this.#extractParams(funcbody);
			this.#add("function", nameToken.getText(), ctx, params);
			return this.visitChildren(ctx);
		}
		return this.visitChildren(ctx);
	}
}

export default class LuaMap {
	static status = "done";
	static entryRule = "chunk";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
