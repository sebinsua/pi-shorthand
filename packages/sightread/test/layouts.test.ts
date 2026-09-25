// Exercise solution configs and bare-container worktrees through the real CLI and graph.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findProject } from "../src/project.ts";
import { connect, stopServer } from "../src/server/client.ts";

const temporaryRoot = realpathSync("/tmp");
const runtime = mkdtempSync(join(temporaryRoot, "sr-w11-r-"));
const oldRuntime = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = runtime;
const roots: string[] = [];
const servers = new Map<string, { root: string; tsconfig: string }>();
const cli = join(import.meta.dir, "../src/cli.ts");
const tsx = [
	"type Row<T> = { id: string; value: T };",
	"export function View<T>({ rows }: { rows: Row<T>[] }) {",
	"  return <main><h1>Rows</h1><section>{rows.map((row) =>",
	"    <article key={row.id}><header>{row.id}</header><p>{String(row.value)}</p></article>",
	"  )}</section></main>;",
	"}",
].join("\n");

function directory() {
	const root = mkdtempSync(join(temporaryRoot, "sr-w11-"));
	roots.push(root);
	return root;
}

function put(root: string, path: string, content: string) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function command(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["bun", cli, ...args], { cwd, env: { ...Bun.env, XDG_RUNTIME_DIR: runtime } });
	return {
		code: result.exitCode,
		out: new TextDecoder().decode(result.stdout).trimEnd(),
		err: new TextDecoder().decode(result.stderr).trimEnd(),
	};
}

function git(cwd: string, ...args: string[]) {
	return execFileSync(
		"git",
		[
			"-c",
			"user.email=sightread@example.test",
			"-c",
			"user.name=Sightread Test",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{
			cwd,
			encoding: "utf8",
		},
	).trim();
}

function vite(root: string) {
	put(
		root,
		"tsconfig.json",
		'{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}',
	);
	put(root, "tsconfig.app.json", '{"compilerOptions":{"jsx":"preserve"},"include":["src/**/*"]}');
	put(root, "tsconfig.node.json", '{"include":["tools/**/*"]}');
	put(root, "src/price.ts", "export function formatPrice(value: number) { return `$${value}`; }\n");
	put(root, "src/View.tsx", tsx);
	put(root, "tools/build.ts", "export function buildTool() { return true; }\n");
}

async function project(cwd: string) {
	const result = await findProject(cwd);
	servers.set(result.tsconfig, result);
	return result;
}

afterAll(async () => {
	for (const item of servers.values()) await stopServer(item);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
	if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = oldRuntime;
});

test("Vite root chooses the app config, reports it in text and JSON, and indexes TSX", async () => {
	const root = directory();
	vite(root);
	const selected = await project(root);
	expect(selected).toEqual({ root, tsconfig: join(root, "tsconfig.app.json") });
	const lookup = command(root, JSON.stringify({ type: "lookup", query: "formatPrice" }));
	expect(lookup.code).toBe(0);
	expect(lookup.out).toContain("lookup for formatPrice (tsconfig.app.json): 1 shown");
	expect(lookup.out).toContain("formatPrice  function  src/price.ts:1-1");
	const json = command(root, "--json", JSON.stringify({ type: "lookup", query: "View" }));
	expect(json.code).toBe(0);
	const result = JSON.parse(json.out) as Array<{
		tsconfig: string;
		nodes: Array<{ name: string; ranges?: Array<{ end: number }> }>;
	}>;
	expect(result[0].tsconfig).toBe("tsconfig.app.json");
	expect(result[0].nodes.find((node) => node.name === "View")?.ranges?.[0]?.end).toBe(6);
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-m", "base");
	put(root, "src/price.ts", "export function formatPrice(value: number) { return `£${value}`; }\n");
	const diff = command(root, "diff", "HEAD");
	expect(diff.code).toBe(0);
	expect(diff.out).toStartWith(
		`diff ${git(root, "rev-parse", "--short=12", "HEAD")} → working tree (.) (tsconfig.app.json): 1 changed`,
	);
	expect(diff.out).toContain("formatPrice  function  edited");
	const diffJson = command(root, "--json", "diff", "HEAD");
	expect((JSON.parse(diffJson.out) as { tsconfig: string }).tsconfig).toBe("tsconfig.app.json");
}, 30_000);

test("solution config in a monorepo subfolder keeps that root and selects by cwd", async () => {
	const repo = directory();
	const root = join(repo, "client");
	vite(root);
	expect(await project(root)).toEqual({ root, tsconfig: join(root, "tsconfig.app.json") });
	expect(await project(join(root, "tools"))).toEqual({ root, tsconfig: join(root, "tsconfig.node.json") });
	const app = await connect(await project(root));
	const node = await connect(await project(join(root, "tools")));
	expect(app.pid).not.toBe(node.pid);
	expect((await connect(await project(root))).pid).toBe(app.pid);
	expect(command(root, '{"type":"lookup","query":"formatPrice"}').out).toContain("src/price.ts:1-1");
	expect(command(join(root, "tools"), '{"type":"lookup","query":"buildTool"}').out).toContain("tools/build.ts:1-1");
}, 30_000);

test("nested solution config resolves a directory reference", async () => {
	const root = directory();
	put(root, "tsconfig.json", '{"references":[{"path":"./group"}]}');
	put(root, "group/tsconfig.json", '{"files":[],"references":[{"path":"./app/tsconfig.json"}]}');
	put(root, "group/app/tsconfig.json", '{"include":["src/**/*"],"compilerOptions":{"jsx":"preserve"}}');
	put(root, "group/app/src/price.ts", "export function nestedPrice() { return 1; }\n");
	put(root, "group/app/src/View.tsx", tsx);
	expect(await project(root)).toEqual({ root, tsconfig: join(root, "group/app/tsconfig.json") });
	expect(command(root, '{"type":"lookup","query":"nestedPrice"}').out).toContain("group/app/src/price.ts:1-1");
}, 30_000);

test("bare-container worktree falls back to main and root discovery stays readable", async () => {
	const container = directory();
	git(container, "init", "--bare", ".bare");
	put(container, ".git", "gitdir: ./.bare\n");
	git(container, "worktree", "add", "-b", "main", "main");
	const main = join(container, "main");
	put(main, "client/tsconfig.json", '{"compilerOptions":{"jsx":"preserve"},"include":["src/**/*"]}');
	put(main, "client/src/price.ts", "export function formatPrice() { return 1; }\n");
	put(main, "client/src/View.tsx", tsx);
	git(main, "add", ".");
	git(main, "commit", "-m", "base");
	git(container, "worktree", "add", "-b", "feature", "feature", "main");
	const feature = join(container, "feature");
	put(feature, "client/src/price.ts", "export function formatPrice() { return 2; }\n");
	await project(join(feature, "client"));
	const diff = command(join(feature, "client"), "diff");
	expect(diff.code).toBe(0);
	expect(diff.out).toStartWith(`diff ${git(feature, "rev-parse", "--short=12", "main")} (main) → working tree`);
	expect(diff.out).toContain("formatPrice  function  edited");
	const discovery = command(container, '{"type":"lookup","query":"formatPrice"}');
	expect(discovery).toMatchObject({
		code: 1,
		err: "sightread: no tsconfig.json above this directory; try --cwd feature/client (nearby: main/client)",
	});
}, 30_000);

test("normal clone prefers origin/HEAD over a local main ref", async () => {
	const source = directory();
	git(source, "init", "-q", "-b", "main");
	put(source, "client/tsconfig.json", '{"compilerOptions":{"jsx":"preserve"},"include":["src/**/*"]}');
	put(source, "client/src/price.ts", "export function formatPrice() { return 1; }\n");
	put(source, "client/src/View.tsx", tsx);
	git(source, "add", ".");
	git(source, "commit", "-m", "base");
	const parent = directory();
	git(parent, "clone", "-q", source, "clone");
	const clone = join(parent, "clone");
	git(clone, "checkout", "-qb", "feature");
	put(clone, "client/src/price.ts", "export function formatPrice() { return 2; }\n");
	await project(join(clone, "client"));
	const output = command(join(clone, "client"), "diff");
	expect(output.code).toBe(0);
	expect(output.out).toStartWith(`diff ${git(clone, "rev-parse", "--short=12", "main")} (origin/HEAD) → working tree`);
	expect(output.out).toContain("formatPrice  function  edited");
}, 30_000);

test("a bounded discovery error is not cut at 240 characters", () => {
	const root = directory();
	const names = Array.from(
		{ length: 12 },
		(_, index) => `project-${String(index).padStart(2, "0")}-${"long".repeat(8)}`,
	);
	for (const name of names) put(root, `${name}/tsconfig.json`, "{}");
	const output = command(root, '{"type":"lookup","query":"anything"}');
	const expected = `sightread: no tsconfig.json above this directory; try --cwd ${names[0]} (nearby: ${names.slice(1, 10).join(", ")})`;
	expect(expected.length).toBeGreaterThan(240);
	expect(output).toMatchObject({ code: 1, err: expected });
});
