// usage: node scripts/anatomy/extract-class.mjs <spec.json>
// spec: { file, origin, newClass, newFile, instanceField, members: [names without #], doc }
// Moves the named members of `origin` (4-space class body) into a new class that receives the origin's
// fields and private methods it uses by constructor injection; the origin constructs it and delegates.
import { readFileSync, writeFileSync } from "node:fs";
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const src = readFileSync(spec.file, "utf8").split("\n"); if (src.at(-1) === "") src.pop();
const L = (n) => src[n - 1];
const findLine = (re, from = 1) => { const i = src.findIndex((l, idx) => idx + 1 >= from && re.test(l)); if (i < 0) throw new Error(`not found ${re}`); return i + 1; };
const startOf = (n) => { while (/^\s*\/\//.test(L(n - 1))) n--; return n; };
const classLine = findLine(new RegExp(`^export default class ${spec.origin}\\b`));
if (L(src.length) !== "}") throw new Error("class must close the file");
// fields
const fields = new Map();
for (let n = classLine + 1; n <= src.length; n++) { const head = L(n).match(/^    (?:readonly )?(#[a-zA-Z_][a-zA-Z0-9_]*)([?!]?): (.*)$/); if (!head) continue; let text = head[3], end = n; const balanced = (t) => { let d = 0; for (const ch of t.replace(/=>/g, "")) { if ("<([{".includes(ch)) d++; if (">)]}".includes(ch)) d--; } return d === 0; }; while (!(text.endsWith(";") && balanced(text))) { end++; if (end > src.length) throw new Error(`field declaration at ${n} never closes`); text += "\n" + L(end); } fields.set(head[1], { n, end, optional: head[2] === "?", late: head[2] === "!", type: text.slice(0, -1).replace(/\n\s*/g, " "), decl: `    readonly ${head[1]}${head[2]}: ${text.slice(0, -1).replace(/\n\s*/g, " ")};` }); n = end; }
// member heads
const heads = []; for (let n = classLine + 1; n <= src.length; n++) { const l = L(n); const m = l.match(/^    (static )?(async )?(#?)([a-zA-Z_][a-zA-Z0-9_]*)(?:<[^>]*>)?\(/); if (m && !/^\s*(if|for|while|switch|return|await|throw|catch)\b/.test(l.trim()) && !fields.has(`#${m[4]}`)) heads.push({ name: m[4], priv: m[3] === "#", isStatic: !!m[1], isAsync: !!m[2], n }); }
heads.forEach((h, i) => { h.start = startOf(h.n); h.end = (heads[i + 1] ? startOf(heads[i + 1].n) : src.length) - 1; });
const byName = new Map(heads.map((h) => [h.name, h])); if (byName.size !== heads.length) throw new Error("duplicate member names");
const ctor = byName.get("constructor") ?? null;
if (ctor) for (const h of heads) if (h.start < ctor.n && h.end >= ctor.n) throw new Error("span overlaps constructor");
// field declarations inside a member span (initialised fields after the constructor) end the span early
const fieldLines = [...fields.values()].map((f) => f.n).concat([...src.keys()].map((i) => i + 1).filter((n) => /^    #[a-zA-Z_][a-zA-Z0-9_]* = /.test(L(n))));
for (const h of heads) { const cut = fieldLines.filter((n) => n > h.n && n <= h.end); if (cut.length) h.end = Math.min(...cut) - 1; }
const memberSet = new Set(spec.members); for (const m of spec.members) if (!byName.has(m)) throw new Error(`no member ${m}`);
const text = (name) => src.slice(byName.get(name).start - 1, byName.get(name).end).join("\n");
const moved = spec.members.map(text).join("\n\n");
// dependencies of the moved text
const usedFields = [...fields.keys()].filter((f) => new RegExp(`this\\.${f}(?![a-zA-Z0-9_])`).test(moved));
const publicHeads = new Set(heads.filter((h) => !h.priv && h.name !== "constructor").map((h) => h.name));
// every this.<name> the moved code touches must be a field, a moved member, or a public method declared in this file — inherited or public-field members are not something this tool can inject
{ const known = new Set([...heads.map((h) => h.name)]); const unresolved = [...new Set([...moved.matchAll(/this\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))].filter((n) => !known.has(n)); if (unresolved.length) throw new Error(`moved members reach this.${unresolved.join(", this.")} — public fields or inherited members this tool cannot inject; not a mechanical extraction`); }
const calledPublic = [...new Set([...moved.matchAll(/this\.([a-zA-Z_][a-zA-Z0-9_]*)\(/g)].map((m) => m[1]))].filter((m) => publicHeads.has(m) && !memberSet.has(m));
const calledPrivate = [...new Set([...moved.matchAll(/this\.#([a-zA-Z_][a-zA-Z0-9_]*)\(/g)].map((m) => m[1]))].filter((m) => !fields.has(`#${m}`) && !memberSet.has(m)).concat(calledPublic);
const calledStatic = [...new Set([...moved.matchAll(new RegExp(`${spec.origin}\\.#([a-zA-Z_][a-zA-Z0-9_]*)\\(`, "g"))].map((m) => m[1]))].filter((m) => !memberSet.has(m));
// origin statics the moved code calls are injected as callbacks too (no binding needed)
// injected fields must not be reassigned outside the constructor
const lateFields = usedFields.filter((f) => fields.get(f).late || src.some((l, i) => new RegExp(`this\\.${f} = `).test(l) && (!ctor || i + 1 < ctor.start || i + 1 > ctor.end)));
// callback types from the private methods' signatures
const signature = (name) => { const h = byName.get(name); let out = "", n = h.n; const headRe = h.priv ? /^    (static )?(async )?#/ : /^    (static )?(async )?/; const balanced = (text) => { let p = 0, b = 0, a = 0; for (const ch of text.replace(/=>/g, "")) { if (ch === "(") p++; if (ch === ")") p--; if (ch === "{") b++; if (ch === "}") b--; if (ch === "<") a++; if (ch === ">") a--; } return p === 0 && b === 0 && a === 0; }; for (;;) { const l = L(n); out += (n === h.n ? l.replace(headRe, "") : "\n" + l); if (/\{\s*$/.test(l) && !/[:<|&,=(]\s*\{\s*$/.test(l) && balanced(out.replace(/\{\s*$/, ""))) break; if (++n > h.end) throw new Error(`signature of ${name} not closed`); } const open = out.indexOf("("); if (open < 0) throw new Error(`cannot parse signature of ${name}`); let depth = 0, close = -1; for (let i = open; i < out.length; i++) { if (out[i] === "(") depth++; if (out[i] === ")") { depth--; if (depth === 0) { close = i; break; } } } if (close < 0) throw new Error(`unbalanced parameters of ${name}`); const params = out.slice(open, close + 1); const rest = out.slice(close + 1).trim().replace(/\{\s*$/, "").trim(); if (!rest.startsWith(":")) throw new Error(`${name} needs an explicit return type to be injected`); return { params, ret: rest.slice(1).trim().replace(/\n\s*/g, " ") }; };
const splitTop = (text) => { const parts = []; let depth = 0, cur = ""; for (const ch of text.replace(/=>/g, "\uE000")) { if ("<([{".includes(ch)) depth++; if (">)]}".includes(ch)) depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch; } if (cur.trim()) parts.push(cur); return parts.map((p) => p.replace(/\uE000/g, "=>")); };
const paramType = (params) => { const inner = params.trim().slice(1, -1); const parts = splitTop(inner).map((p, idx) => { const q = p.trim(); if (/^[{[]/.test(q)) { let depth = 0; for (let i = 0; i < q.length; i++) { if ("{[(<".includes(q[i])) depth++; if ("}])>".includes(q[i])) depth--; if (depth === 0) { const rest = q.slice(i + 1).trim(); if (!rest.startsWith(":")) throw new Error(`destructured parameter without a type: ${q.slice(0, 40)}`); return `arg${idx}: ${rest.slice(1).trim().replace(/ = [\s\S]*$/, "")}`; } } throw new Error(`unbalanced parameter ${q.slice(0, 40)}`); } let depth = 0; for (let i = 0; i < p.length; i++) { const ch = p[i]; if ("<([{".includes(ch)) depth++; if (">)]}".includes(ch)) depth--; if (depth === 0 && p.startsWith(" = ", i)) { const head = p.slice(0, i).trim(); const dflt = p.slice(i + 3).trim(); const colon = head.indexOf(":"); if (colon >= 0) return `${head.slice(0, colon)}?${head.slice(colon)}`; const lit = /^"/.test(dflt) ? "string" : /^(true|false)$/.test(dflt) ? "boolean" : /^-?\d/.test(dflt) || /^(Date|performance)\.now\(\)$/.test(dflt) ? "number" : null; if (!lit) throw new Error(`untyped default parameter ${head} = ${dflt}`); return `${head}?: ${lit}`; } } return p.trim(); }); return `(${parts.join(", ")})`; };
const callbacks = [...calledPrivate, ...calledStatic].map((name) => { const { params, ret } = signature(name); return { name, type: `${paramType(params.replace(/\n\s*/g, " "))} => ${ret}`, isStatic: calledStatic.includes(name) }; });
// which moved members the origin still calls (→ public), and which are called only inside the set (→ stay private)
const remaining = src.filter((l, i) => !spec.members.some((m) => i + 1 >= byName.get(m).start && i + 1 <= byName.get(m).end)).join("\n");
const publicMembers = spec.members.filter((m) => new RegExp(`(?:this|${spec.origin})\\.#${m}\\(`).test(remaining));
// new class text
const staticFields = []; src.forEach((l, i) => { if (i + 1 <= classLine) return; const m = l.match(/^    static (?:readonly )?([a-zA-Z_][a-zA-Z0-9_]*): ([^=]+?) = /); if (m) staticFields.push({ name: m[1], type: m[2].trim() }); });
const usedStatics = staticFields.filter((sf) => new RegExp(`${spec.origin}\\.${sf.name}(?![a-zA-Z0-9_(])`).test(moved));
const injectedStatics = usedStatics.map((sf) => ({ name: sf.name, decl: `    readonly #${sf.name}: ${sf.type};`, param: `        ${sf.name}: ${sf.type};`, fromStatic: true }));
let body = moved.replace(new RegExp(`this\\.(${lateFields.join("|") || "__none__"})(?![a-zA-Z0-9_(])`, "g"), "this.$1()").replace(new RegExp(`${spec.origin}\\.(${usedStatics.map((sf) => sf.name).join("|") || "__none__"})(?![a-zA-Z0-9_(])`, "g"), "this.#$1").replace(new RegExp(`this\\.(${calledPublic.join("|") || "__none__"})\\(`, "g"), "this.#$1(").replace(new RegExp(`${spec.origin}\\.#(${calledStatic.join("|") || "__none__"})\\(`, "g"), "this.#$1(");
for (const m of publicMembers) body = body.replace(new RegExp(`^(    )(static )?(async )?#${m}\\(`, "m"), "$1$2$3" + m + "(");
body = body.replace(new RegExp(`${spec.origin}\\.#(${spec.members.join("|")})\\(`, "g"), (all, m) => `${spec.newClass}.${publicMembers.includes(m) ? "" : "#"}${m}(`);
body = body.replace(new RegExp(`this\\.#(${spec.members.join("|")})\\(`, "g"), (all, m) => `this.${publicMembers.includes(m) ? "" : "#"}${m}(`);
const uncommented = (l) => l.replace(/\s*\/\/.*$/, "");
const initFields = []; for (let i = classLine; i < src.length; i++) { const m = src[i].match(/^    (?:readonly )?(#[a-zA-Z_][a-zA-Z0-9_]*) = /); if (!m) continue; let end = i, text = uncommented(src[i]); const bal = (t) => { let d = 0; for (const ch of t.replace(/=>/g, "")) { if ("<([{".includes(ch)) d++; if (">)]}".includes(ch)) d--; } return d === 0; }; while (!(/;\s*$/.test(text) && bal(text))) { end++; if (end >= src.length) throw new Error(`initialized field ${m[1]} never closes`); text += "\n" + uncommented(src[end]); } initFields.push({ name: m[1], n: i + 1, end: end + 1, decl: text.replace(/\n\s*/g, " ") }); i = end; }
const usedInitFields = initFields.filter((fld) => new RegExp(`this\\.${fld.name}(?![a-zA-Z0-9_])`).test(moved));
const originRest = src.filter((l, i) => !spec.members.some((m) => i + 1 >= byName.get(m).start && i + 1 <= byName.get(m).end) && !initFields.some((fld) => i + 1 >= fld.n && i + 1 <= fld.end)).join("\n");
const movedInitFields = usedInitFields.filter((fld) => !new RegExp(`this\\.${fld.name}(?![a-zA-Z0-9_])`).test(originRest));
const sharedInitFields = usedInitFields.filter((fld) => !movedInitFields.includes(fld)).map((fld) => { const m = fld.decl.match(/= new ([A-Za-z_][A-Za-z0-9_]*(?:<.*>)?)\(\);$/); if (!m) throw new Error(`shared state field ${fld.name} needs a new X<...>() initializer to be typed`); return { name: fld.name.slice(1), decl: `    readonly ${fld.name}: ${m[1]};`, param: `        ${fld.name.slice(1)}: ${m[1]};`, shared: true }; });
const injected = [...injectedStatics, ...sharedInitFields, ...usedFields.filter((f) => lateFields.includes(f)).map((f) => ({ name: f.slice(1), decl: `    readonly ${f}: () => ${fields.get(f).type};`, param: `        ${f.slice(1)}: () => ${fields.get(f).type};`, thunk: true })), ...usedFields.filter((f) => !lateFields.includes(f)).map((f) => ({ name: f.slice(1), decl: fields.get(f).decl.replace(/^    (?:readonly )?/, "    readonly "), param: `        ${f.slice(1)}${fields.get(f).optional ? "?" : ""}: ${fields.get(f).type};` })), ...callbacks.map((c) => ({ name: c.name, decl: `    readonly #${c.name}: ${c.type};`, param: `        ${c.name}: ${c.type};` }))];
const topTypes = []; const topConsts = []; src.forEach((l, i) => { if (i + 1 >= classLine) return; const t = l.match(/^(?:export )?(?:type|interface) ([A-Za-z_][A-Za-z0-9_]*)/); if (t) topTypes.push({ name: t[1], n: i + 1, exported: l.startsWith("export ") }); const c = l.match(/^(?:export )?const ([A-Za-z_][A-Za-z0-9_]*)/); if (c) topConsts.push(c[1]); });
const bodyForRefs = moved + "\n" + callbacks.map((c) => c.type).join("\n") + "\n" + usedFields.map((f) => fields.get(f).type).join("\n");
const refTypes = topTypes.filter((t) => new RegExp(`(?<![A-Za-z0-9_#])(?<!(?<!\\.)\\.)${t.name}(?![A-Za-z0-9_])`).test(bodyForRefs));
const refConsts = topConsts.filter((c) => new RegExp(`(?<![A-Za-z0-9_#])(?<!(?<!\\.)\\.)${c}(?![A-Za-z0-9_])`).test(moved));
const carry = spec.carryConsts ?? [];
const uncarried = refConsts.filter((c) => !carry.includes(c));
if (uncarried.length) throw new Error(`moved members use origin top-level consts: ${uncarried.join(", ")} — list them in carryConsts to move them along, or move them to a shared module first`);
const constBlocks = carry.map((name) => { const head = src.findIndex((l) => new RegExp(`^(?:export )?const ${name}\\b`).test(l)); if (head < 0) throw new Error(`no top-level const ${name}`); let from = head; while (from > 0 && /^\s*\/\//.test(src[from - 1])) from--; let to = head, depth = 0; for (;;) { for (const ch of src[to]) { if ("([{".includes(ch)) depth++; if (")]}".includes(ch)) depth--; } if (depth === 0 && /;\s*$/.test(src[to])) break; to++; if (to >= classLine - 1) throw new Error(`const ${name} never closes`); } return { name, from: from + 1, to: to + 1 }; });
const carriedText = constBlocks.map((b) => src.slice(b.from - 1, b.to).join("\n")).join("\n\n");
const importsEnd = (() => { let last = 0; src.forEach((l, i) => { if (/^import |^} from "/.test(l)) last = i + 1; }); return last; })();
const importLines = []; for (let i = 0; i < importsEnd; i++) { if (!/^import /.test(src[i])) continue; let j = i; importLines.push(src[j]); while (!/;\s*$/.test(src[j])) { j++; importLines.push(src[j]); } i = j; }
const imports = importLines.join("\n");
const originTypeImport = refTypes.length ? `\nimport type { ${refTypes.map((t) => t.name).join(", ")} } from "./${spec.file.split("/").pop()}";` : "";
const staticOnly = injected.length === 0 && movedInitFields.length === 0 && spec.members.every((m) => byName.get(m).isStatic);
const newFile = staticOnly ? `${spec.doc}\n${imports}${originTypeImport}\n\n${carriedText ? carriedText + "\n\n" : ""}export default class ${spec.newClass} {\n${body}\n}\n` : `${spec.doc}\n${imports}${originTypeImport}\n\n${carriedText ? carriedText + "\n\n" : ""}export default class ${spec.newClass} {\n${injected.map((i) => i.decl).join("\n")}${movedInitFields.length ? "\n" + movedInitFields.map((fld) => fld.decl).join("\n") : ""}\n\n    constructor({ ${injected.map((i) => i.name).join(", ")} }: {\n${injected.map((i) => i.param).join("\n")}\n    }) {\n${injected.map((i) => `        this.#${i.name} = ${i.name};`).join("\n")}\n    }\n\n${body}\n}\n`;
// origin: remove spans, add field + construction + import, rewrite call sites
const removed = new Set(); for (const m of spec.members) for (let n = byName.get(m).start; n <= byName.get(m).end; n++) removed.add(n);
for (const fld of movedInitFields) for (let n = fld.n; n <= fld.end; n++) removed.add(n);
for (const b of constBlocks) for (let n = b.from; n <= b.to; n++) removed.add(n);
let out = src.map((l, i) => { const t = refTypes.find((t) => t.n === i + 1 && !t.exported); return t ? `export ${l}` : l; }).filter((l, i) => !removed.has(i + 1));
const constructionArgs = injected.map((i) => i.thunk ? `${i.name}: () => this.#${i.name}` : i.fromStatic ? `${i.name}: ${spec.origin}.${i.name}` : i.shared ? `${i.name}: this.#${i.name}` : callbacks.some((c) => c.name === i.name && c.isStatic) ? `${i.name}: ${spec.origin}.#${i.name}` : callbacks.some((c) => c.name === i.name) ? `${i.name}: this.${calledPublic.includes(i.name) ? "" : "#"}${i.name}.bind(this)` : `${i.name}: this.#${i.name}`).join(", ");
const ctorEndIdx = ctor ? (() => { const startIdx = out.findIndex((l) => l === L(ctor.n)); for (let i = startIdx + 1; i < out.length; i++) if (out[i] === "    }") return i; throw new Error("ctor end"); })() : -1;
const movedPublic = spec.members.filter((m) => !byName.get(m).priv);
for (const m of movedPublic) if (byName.get(m).isStatic) throw new Error(`public static ${m} cannot be delegated by an instance field`);
const delegates = movedPublic.map((m) => `    ${byName.get(m).isAsync ? "async " : ""}${m}(...args: Parameters<${spec.newClass}["${m}"]>): ReturnType<${spec.newClass}["${m}"]> {\n        return this.${spec.instanceField}.${m}(...args);\n    }`);
const construction = `        this.${spec.instanceField} = new ${spec.newClass}({ ${injected.map((i) => i.fromStatic ? `${i.name}: ${spec.origin}.${i.name}` : i.shared ? `${i.name}: this.#${i.name}` : callbacks.some((c) => c.name === i.name && c.isStatic) ? `${i.name}: ${spec.origin}.#${i.name}` : callbacks.some((c) => c.name === i.name) ? `${i.name}: this.${calledPublic.includes(i.name) ? "" : "#"}${i.name}.bind(this)` : `${i.name}: this.#${i.name}`).join(", ")} });`;
if (staticOnly) { /* no instance: the origin calls the statics by class name */ }
else if (ctor) { out.splice(ctorEndIdx, 0, construction); const lastFieldIdx = out.findIndex((l) => l === L(ctor.n)) - 1; let fieldInsert = lastFieldIdx; while (fieldInsert > 0 && out[fieldInsert].trim() === "") fieldInsert--; out.splice(fieldInsert + 1, 0, `    readonly ${spec.instanceField}: ${spec.newClass};`); }
else { const lastInit = Math.max(...initFields.map((fld) => out.indexOf(src[fld.end - 1])), ...[...fields.values()].map((fld) => out.indexOf(fld.decl))); if (lastInit < 0) throw new Error("no field to anchor the instance initializer after"); out.splice(lastInit + 1, 0, `    readonly ${spec.instanceField} = new ${spec.newClass}({ ${constructionArgs} });`); }
if (delegates.length) { if (out.at(-1) !== "}") throw new Error("origin must end with the class close"); out.splice(out.length - 1, 0, "", ...delegates.join("\n\n").split("\n")); }
let origin = out.join("\n");
origin = origin.replace(new RegExp(`this\\.#(${spec.members.join("|")})\\(`, "g"), (all, m) => { if (byName.get(m).isStatic) throw new Error(`static ${m} called via this`); return `this.${spec.instanceField}.${m}(`; });
origin = origin.replace(new RegExp(`${spec.origin}\\.#(${spec.members.join("|")})\\(`, "g"), (all, m) => `${spec.newClass}.${m}(`);
const importLine = `import ${spec.newClass} from "./${spec.newFile.split("/").pop()}";`;
origin = origin.replace(/^(import [^\n]+;\n)(?![\s\S]*^import )/m, `$1${importLine}\n`);
if (!origin.includes(importLine)) throw new Error("import not inserted");
for (const b of constBlocks) if (new RegExp(`(?<![A-Za-z0-9_#])(?<!(?<!\\.)\\.)${b.name}(?![A-Za-z0-9_])`).test(origin)) throw new Error(`origin still uses carried const ${b.name}`);
for (const fld of movedInitFields) if (new RegExp(`this\\.${fld.name}(?![a-zA-Z0-9_])`).test(origin)) throw new Error(`origin still uses moved state field ${fld.name}`);
writeFileSync(spec.newFile, newFile);
writeFileSync(spec.file, origin + "\n");
console.log(`${spec.newClass}: moved ${spec.members.length} members (${moved.split("\n").length} lines); injected fields ${usedFields.join(" ")}; callbacks ${callbacks.map((c) => c.name).join(" ") || "-"}; public ${publicMembers.join(" ") || "-"}`);
