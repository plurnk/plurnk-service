import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import LuaParserVisitor from "./generated/LuaParserVisitor.js";

class Extractor extends withExtractor(LuaParserVisitor) {
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

	visitFuncbody(ctx) {
		return this._gateBody(ctx);
	}

	visitStat(ctx) {
		if (this._inBody) return null;
		// 'function' funcname funcbody
		const funcname = ctx.funcname?.();
		const funcbody = ctx.funcbody?.();
		if (funcname && funcbody) {
			const names = funcname.NAME?.() ?? [];
			const fullName = names.map((n) => n.getText()).join(".");
			if (fullName) {
				const params = this.#extractParams(funcbody);
				this._add("function", fullName, ctx, params);
			}
			return this.visitChildren(ctx);
		}
		// 'local' 'function' NAME funcbody
		const nameToken = ctx.NAME?.();
		if (nameToken && funcbody) {
			const params = this.#extractParams(funcbody);
			this._add("function", nameToken.getText(), ctx, params);
			return this.visitChildren(ctx);
		}
		return this.visitChildren(ctx);
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "chunk",
	extensions: [".lua"],
});
