import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const setups = ["baseline", "code", "replace", "read-code"] as const;
export type Setup = (typeof setups)[number];
export type Documentation = "shipped" | "minimal";

/** API facts only: no batching advice, workflow examples, or skill referral. */
export const minimalDescription = `Execute a TypeScript program with Bun in an isolated repository copy. Top-level await and Bun/Node APIs are available. Use relative repository paths. Successful writes are applied transactionally and returned as a diff; failures return the error and candidate diff. Only tracked and non-ignored files are applied. Writes to .git are blocked.
Synchronous globals:
glob(pattern, dir?) -> string[]
grep(stringOrRegExp, paths?) -> {file, line, text}[]; strings match literally.
sg.find(pattern, files?) -> {file, line, text, vars}[]; files accepts paths, directories, globs or lists (JS/TS). $X matches one node; $$$X matches zero or more.
sg.rewrite(pattern, templateOrFunction, files?) -> number; templates interpolate captures; callbacks receive match with captures directly on it (m.X), returning replacement text or null.
sg.one(pattern, files?) requires one match; sg.file(path) selects a JS/TS file root, including new files.
sg.insert(text, destination), sg.move(match, destination, transform?), sg.remove(match). Destination is exactly one of {before: match}, {after: match}, {startOf: container}, {endOf: container}. Statements/declarations only. Containers are file roots or matched statement blocks. Matches must be refreshed after editing their file. move's optional function transforms text.
sg also exposes ast-grep's native API, including parse and Lang. Importing @ast-grep/napi is supported.
grit(pattern, paths?, {lang?, dryRun?}) -> {file, matches}[].
$ is Bun's asynchronous shell and requires await; ast-grep, grit and git CLIs are available.
timeout is in seconds (default 2). rollback="all" applies nothing on failure. rollback="file" can retain files closed before a timeout if writer inspection succeeds; other failures apply nothing.`;

export function parseSetups(value: string): Setup[] {
	const result = value.split(",");
	if (
		!result.length ||
		result.some((item) => !setups.includes(item as Setup)) ||
		new Set(result).size !== result.length
	)
		throw new Error(`Setups must be distinct members of ${setups.join(", ")}`);
	return result as Setup[];
}

export function conditionTools(setup: Setup): string[] {
	// Explicit lists keep stock and replacement exploration facilities identical.
	const common = ["read", "bash"];
	if (setup === "read-code") return ["read", "code"];
	if (setup === "replace") return [...common, "code"];
	return [...common, "edit", "write", ...(setup === "code" ? ["code"] : [])];
}

export function rotateConditions<T>(conditions: T[], repetition: number): T[] {
	const offset = (repetition - 1) % conditions.length;
	return [...conditions.slice(offset), ...conditions.slice(0, offset)];
}

/** Wrap registration rather than changing the shipped extension or its execution behaviour. */
export async function extensionEntry(root: string, documentation: Documentation, destination: string): Promise<string> {
	const entry = path.join(root, "index.ts");
	if (documentation === "shipped") return entry;
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(
		destination,
		`import extension from ${JSON.stringify(pathToFileURL(entry).href)};
export default function(pi) {
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (tool) => target.registerTool(tool.name === "code"
      ? { ...tool, description: ${JSON.stringify(minimalDescription)}, promptSnippet: "Transactional Bun program for repository changes", promptGuidelines: [] }
      : tool);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  extension(proxy);
}
`,
	);
	return destination;
}
