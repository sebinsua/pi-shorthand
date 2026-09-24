import type { ShorthandGlobals } from "../src/program/api.d.ts";

// Checked by npm run check, never executed. These exercise the public program types.
export async function supportedProgram() {
	edit({ path: "src/config.ts", oldText: "timeoutMs: 1000", newText: "timeoutMs: 3000" });
	// @ts-expect-error A replacement requires newText.
	edit({ path: "src/config.ts", oldText: "timeoutMs: 1000" });
	const api: ShorthandGlobals["sg"] = sg;
	const target = api.file("src/app.ts");
	sg.find("run($A)", target);
	sg.one("run($A)", [target, "src/other.ts"]);
	sg.rewrite("run($A)", (match) => match.A.toUpperCase(), target);
	sg.insert("initialize();", { endOf: target });
	grit("`run($a)` => `go($a)`", [target, "src/**/*.ts"]);
	await refactor.rename({ file: "src/app.ts", symbol: "run", to: "start" });
	await refactor.renameFile({ from: "src/other.ts", to: "src/start.ts" });
	await refactor.move({ file: "src/app.ts", symbol: "start", to: "src/start.ts" });
	// Paths are typed as strings; file targets are accepted at runtime but not advertised.
	// @ts-expect-error A file target is not part of the documented path type.
	edit({ path: target, oldText: "a", newText: "b" });
	// @ts-expect-error A semantic rename requires the new name.
	await refactor.rename({ file: "src/app.ts", symbol: "run" });
	// @ts-expect-error A file rename requires the destination.
	await refactor.renameFile({ from: "src/other.ts" });

	// @ts-expect-error A plain object is not an sg.file target.
	sg.find("run($A)", { file: "src/app.ts" });
	// @ts-expect-error A match is not a file scope.
	sg.find("run($A)", sg.one("run($A)", target));
	// @ts-expect-error No invented helper.
	sg.replaceAll("run($A)", "go($A)");
	// @ts-expect-error Placement needs one destination.
	sg.insert("initialize();", { before: target, after: target });
}
