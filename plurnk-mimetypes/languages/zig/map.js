import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ZigParserVisitor from "./generated/ZigParserVisitor.js";

class Extractor extends withExtractor(ZigParserVisitor) {
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

	visitBlock(ctx) {
		return this._gateBody(ctx);
	}

	visitDecl(ctx) {
		if (this._inBody) return null;
		const fnProto = ctx.fn_proto?.();
		if (fnProto) {
			const id = fnProto.IDENTIFIER?.();
			if (id) {
				const params = this.#extractParams(fnProto.param_decl_list?.());
				this._add("function", id.getText(), ctx, params);
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
				this._add(containerKind, name, ctx);
				return this.visitChildren(ctx);
			}
			if (isConst) {
				this._add("constant", name, ctx);
			} else {
				this._add("variable", name, ctx);
			}
		}
		return null;
	}

	visitTest_decl(ctx) {
		if (this._inBody) return null;
		const strLit = ctx.STRINGLITERAL?.();
		const id = ctx.IDENTIFIER?.();
		const name = strLit?.getText()?.slice(1, -1) ?? id?.getText() ?? "test";
		this._add("function", name, ctx);
		return null;
	}

	visitContainer_field(ctx) {
		const id = ctx.IDENTIFIER?.();
		if (id) this._add("field", id.getText(), ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "root",
	extensions: [".zig"],
});
