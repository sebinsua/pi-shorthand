import { expect, test } from "bun:test";
import { Lang, parse } from "@ast-grep/napi";
import { discardedEdits } from "../program-lint.ts";

const warnings = (program: string) => discardedEdits(parse(Lang.TypeScript, program).root());

test("warns for the benchmark's discarded body edit through const aliases", () => {
	const result = warnings(`const method = sg.one(pattern, "policy.ts");
const body = method.node.field("body");
if (!body) throw new Error("no body");
body.replace("{ return computeDelay(attempt, settings); }");`);
	expect(result).toHaveLength(1);
	expect(result[0]).toContain("line 4:");
	expect(result[0]).toContain("this result was discarded");
});

test("recognizes native node chains and non-null assertions", () => {
	expect(warnings('sg.one(pattern).node.getMatch("A")!.replace("x");')).toHaveLength(1);
	expect(warnings('const root = sg.parse("TypeScript", source).root(); root.find(pattern).replace("x");')).toHaveLength(
		1,
	);
});

test("does not warn for returned, stored or committed edits", () => {
	for (const program of [
		'sg.rewrite(pattern, m => m.node.replace("x"));',
		'const node = sg.one(pattern).node; const edit = node.replace("x");',
		'const node = sg.one(pattern).node; node.getRoot().root().commitEdits([node.replace("x")]);',
		'const node = sg.one(pattern).node; function edit() { return node.replace("x"); }',
	])
		expect(warnings(program)).toEqual([]);
});

test("does not confuse string or application methods with native nodes", () => {
	for (const program of [
		'const s = "old"; s.replace("old", "new");',
		"const app = { replace() {} }; app.replace();",
		'const sg = application; sg.one(pattern).node.replace("x");',
		'function edit(sg) { sg.one(pattern).node.replace("x"); }',
		'const node = sg.one(pattern).node; function edit(node) { node.replace("x"); }',
		'let node = sg.one(pattern).node; node = application; node.replace("x");',
		'const { node } = application; node.replace("x");',
		'const { sg } = application; sg.one(pattern).node.replace("x");',
		'function edit({sg}) { sg.one(pattern).node.replace("x"); }',
		'for (const sg of applications) { sg.one(pattern).node.replace("x"); }',
		'for (const sg in applications) { sg.one(pattern).node.replace("x"); }',
		'class sg { static one() { return application; } } sg.one(pattern).node.replace("x");',
		'const C = class sg { edit() { sg.one(pattern).node.replace("x"); } };',
		'function* edit(sg) { sg.one(pattern).node.replace("x"); }',
		'import {sg} from "app"; sg.one(pattern).node.replace("x");',
		'try {} catch ({sg}) { sg.one(pattern).node.replace("x"); }',
	])
		expect(warnings(program)).toEqual([]);
});
