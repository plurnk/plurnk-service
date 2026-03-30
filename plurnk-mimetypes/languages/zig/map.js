import ZigParserVisitor from "./generated/ZigParserVisitor.js";

class SymbolExtractor extends ZigParserVisitor {
	#symbols = [];
	#inBlock = false;

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

	#extractParams(paramDeclList) {
		if (!paramDeclList) return [];
		const decls = paramDeclList.param_decl?.() ?? [];
		const params = [];
		for (const decl of decls) {
			const id = decl.IDENTIFIER?.();
			if (id) {
				params.push(id.getText());
			} else if (decl.getText() === "...") {
				params.push("...");
			}
		}
		return params;
	}

	#findContainerKind(expr) {
		if (!expr) return null;
		return this.#walkForContainerKind(expr);
	}

	#walkForContainerKind(node) {
		if (!node?.children) return null;
		for (const child of node.children) {
			const ruleName = child.constructor?.name;
			if (ruleName === "Container_decl_typeContext") {
				if (child.STRUCT?.()) return "class";
				if (child.UNION?.()) return "class";
				if (child.ENUM?.()) return "enum";
				if (child.OPAQUE?.()) return "interface";
				return null;
			}
			const result = this.#walkForContainerKind(child);
			if (result) return result;
		}
		return null;
	}

	// Scope boundary: block inside fn is the wall.
	visitBlock(ctx) {
		const wasInBlock = this.#inBlock;
		this.#inBlock = true;
		this.visitChildren(ctx);
		this.#inBlock = wasInBlock;
		return null;
	}

	visitDecl(ctx) {
		if (this.#inBlock) return null;
		const fnProto = ctx.fn_proto?.();
		if (fnProto) {
			const id = fnProto.IDENTIFIER?.();
			if (id) {
				const params = this.#extractParams(fnProto.param_decl_list?.());
				this.#add("function", id.getText(), ctx, params);
			}
			return this.visitChildren(ctx);
		}
		const globalVar = ctx.global_var_decl?.();
		if (globalVar) {
			const varProto = globalVar.var_decl_proto?.();
			if (!varProto) return null;
			const id = varProto.IDENTIFIER?.();
			if (!id) return null;
			const name = id.getText();
			const isConst = !!varProto.CONST?.();
			const containerKind = this.#findContainerKind(globalVar.expr?.());
			if (containerKind) {
				this.#add(containerKind, name, ctx);
				return this.visitChildren(ctx);
			}
			if (isConst) {
				this.#add("constant", name, ctx);
			} else {
				this.#add("variable", name, ctx);
			}
		}
		return null;
	}

	visitTest_decl(ctx) {
		if (this.#inBlock) return null;
		const strLit = ctx.STRINGLITERAL?.();
		const id = ctx.IDENTIFIER?.();
		const name = strLit?.getText()?.slice(1, -1) ?? id?.getText() ?? "test";
		this.#add("function", name, ctx);
		return null;
	}

	visitContainer_field(ctx) {
		const id = ctx.IDENTIFIER?.();
		if (id) this.#add("field", id.getText(), ctx);
		return null;
	}
}

export default class ZigMap {
	static status = "done";
	static entryRule = "root";
	static extensions = [".zig"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
