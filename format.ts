/** Best-effort formatting using existing project tools. Runs inside the editing workspace. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

type Command = { name: string; executable: string; args: string[]; cwd: string };

/** A conservative filter: configuration and executable discovery still happen inside the sandbox. */
export function supportsFormatting(file: string): boolean {
	return (
		/\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less|html|vue|svelte|mdx?|ya?ml|graphql)$/i.test(file) ||
		[".py", ".pyi", ".go", ".rs"].includes(extname(file))
	);
}

function text(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function directories(start: string, root: string): string[] {
	const result = [];
	for (let dir = start; ; dir = dirname(dir)) {
		result.push(dir);
		if (dir === root || dirname(dir) === dir) return result;
	}
}

export function formatterFor(file: string, root: string): Command | null {
	root = resolve(root);
	const extension = extname(file);
	const js = /\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less|html|vue|svelte|mdx?|ya?ml|graphql)$/i.test(extension);
	for (const cwd of directories(dirname(resolve(root, file)), root)) {
		const has = (...names: string[]) => names.some((name) => existsSync(join(cwd, name)));
		let name: string | undefined;
		let args: string[] = [];
		if (js) {
			let pkg: {
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				prettier?: unknown;
			};
			try {
				pkg = JSON.parse(text(join(cwd, "package.json")) || "{}");
			} catch {
				return null;
			}
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			const choices = [
				...(deps.prettier ||
				pkg.prettier !== undefined ||
				has(
					".prettierrc",
					".prettierrc.json",
					".prettierrc.yaml",
					".prettierrc.yml",
					".prettierrc.js",
					".prettierrc.cjs",
					".prettierrc.mjs",
					"prettier.config.js",
					"prettier.config.cjs",
					"prettier.config.mjs",
					"prettier.config.ts",
				)
					? ["prettier"]
					: []),
				...(deps.oxfmt || has(".oxfmtrc.json", ".oxfmtrc.jsonc") ? ["oxfmt"] : []),
				...(deps["@biomejs/biome"] || has("biome.json", "biome.jsonc") ? ["biome"] : []),
			];
			// Recognize the executable, never execute an arbitrary package script.
			const script = pkg.scripts?.format;
			const scripted = script?.match(/^(prettier|oxfmt|biome)(?:\s|$)/)?.[1];
			// Custom wrappers/options may encode conventions we cannot reproduce. Leave them alone.
			if (
				script &&
				(!scripted ||
					/[;&|`$<>]/.test(script) ||
					(script.match(/(?<!\S)--?[\w-]+(?:=\S+)?/g) ?? []).some(
						(flag) => !["--write", "--check", "--ignore-unknown"].includes(flag),
					))
			)
				return null;
			if (!scripted && choices.length > 1) return null;
			name = scripted ?? choices[0];
			args =
				name === "prettier"
					? ["--write", "--ignore-unknown"]
					: name === "biome"
						? ["format", "--write", "--files-ignore-unknown=true"]
						: [];
		} else if (extension === ".py" || extension === ".pyi") {
			const config = text(join(cwd, "pyproject.toml"));
			const ruff = has("ruff.toml", ".ruff.toml") || /\[tool\.ruff(?:\.|\])/.test(config);
			const black = /\[tool\.black\]/.test(config);
			if (ruff && black) return null;
			name = ruff ? "ruff" : black ? "black" : undefined;
			args = name === "ruff" ? ["format"] : [];
		} else if (extension === ".go" && has("go.mod", "go.work")) {
			name = "gofmt";
			args = ["-w"];
		} else if (extension === ".rs" && has("Cargo.toml")) {
			const cargo = text(join(cwd, "Cargo.toml"));
			if (/edition\s*\.\s*workspace\s*=/.test(cargo)) return null;
			name = "rustfmt";
			args = ["--edition", cargo.match(/^\s*edition\s*=\s*["'](\d+)["']/m)?.[1] ?? "2015"];
		}
		if (!name) continue;
		const search = directories(cwd, root);
		const candidates = search.map((dir) => join(dir, js ? "node_modules/.bin" : ".venv/bin", name!));
		// JS formatters must belong to this project, not the extension's dependencies.
		const executable = candidates.find((candidate) => Bun.which(candidate)) ?? (!js ? Bun.which(name) : null);
		return executable ? { name, executable, args, cwd } : null;
	}
	return null;
}

/** Files of one kind share a formatter decision: JS-family files, Python, Go or Rust. */
function formatterKind(file: string): string {
	const extension = extname(file);
	if (/\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less|html|vue|svelte|mdx?|ya?ml|graphql)$/i.test(extension)) return "js";
	return extension === ".pyi" ? ".py" : extension;
}

export async function formatChanged(
	files: string[],
	root: string,
): Promise<{ messages: string[]; warnings: string[] }> {
	const groups = new Map<string, { command: Command; files: string[] }>();
	const result = { messages: [] as string[], warnings: [] as string[] };
	// The choice depends only on a file's directory and kind of source, and each lookup checks several
	// config files per ancestor directory, so decide once for files that share both.
	const decided = new Map<string, Command | null>();
	for (const file of files) {
		const place = `${dirname(resolve(root, file))}\0${formatterKind(file)}`;
		if (!decided.has(place)) decided.set(place, formatterFor(file, root));
		const command = decided.get(place)!;
		if (!command) continue;
		const key = JSON.stringify(command);
		const group = groups.get(key) ?? { command, files: [] };
		group.files.push("./" + relative(command.cwd, resolve(root, file)));
		groups.set(key, group);
	}
	for (const { command, files: targets } of groups.values()) {
		try {
			const child = Bun.spawn([command.executable, ...command.args, ...targets], {
				cwd: command.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (code !== 0)
				result.warnings.push(
					`${command.name} formatting failed: ${(stderr || stdout).trim().slice(-2000) || `exit ${code}`}`,
				);
			else result.messages.push(`Formatted ${targets.length} file(s) with ${command.name}.`);
		} catch (error) {
			result.warnings.push(`${command.name} formatting failed: ${String(error)}`);
		}
	}
	return result;
}
