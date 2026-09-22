import { AsyncLocalStorage } from "node:async_hooks";

export interface DiagnosticSpan {
	name: string;
	startMs: number;
	durationMs?: number;
	failed?: boolean;
}

export interface Diagnostics {
	spans: DiagnosticSpan[];
	counters: Record<string, number>;
	phase?: string;
	failurePhase?: string;
	runnerMs?: number;
	startupMs?: number;
	responseMs?: number;
	wallMs?: number;
	incomplete?: boolean;
}

const context = new AsyncLocalStorage<{
	startedAt: number;
	diagnostics: Diagnostics;
	publish: (diagnostics: Diagnostics) => void;
	phaseSpan?: DiagnosticSpan;
}>();

/** Run-local, bounded metadata only: never record source text, filenames or command output. */
export async function withDiagnostics<T>(
	operation: () => Promise<T>,
	publish: (diagnostics: Diagnostics) => void,
): Promise<{ value: T; diagnostics: Diagnostics }> {
	const state = {
		startedAt: performance.now(),
		diagnostics: { spans: [], counters: {} } as Diagnostics,
		publish: (diagnostics: Diagnostics) => {
			try {
				publish(diagnostics);
			} catch {
				/* Diagnostics must not change the operation's outcome. */
			}
		},
	};
	return context.run(state, async () => {
		state.publish(state.diagnostics);
		try {
			return { value: await operation(), diagnostics: state.diagnostics };
		} catch (error) {
			diagnosticFailure();
			throw error;
		} finally {
			const active = context.getStore()!;
			if (active.phaseSpan)
				active.phaseSpan.durationMs = Math.round(performance.now() - state.startedAt - active.phaseSpan.startMs);
			state.diagnostics.runnerMs = Math.round(performance.now() - state.startedAt);
			state.publish(state.diagnostics);
		}
	});
}

export async function measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const state = context.getStore();
	if (!state) return operation();
	const start = performance.now();
	const span: DiagnosticSpan = { name, startMs: Math.round(start - state.startedAt) };
	state.diagnostics.spans.push(span);
	state.publish(state.diagnostics);
	try {
		return await operation();
	} catch (error) {
		span.failed = true;
		throw error;
	} finally {
		span.durationMs = Math.round(performance.now() - start);
		state.publish(state.diagnostics);
	}
}

export function diagnosticCounter(name: string, value: number, add = false) {
	const state = context.getStore();
	if (!state) return;
	state.diagnostics.counters[name] = value + (add ? (state.diagnostics.counters[name] ?? 0) : 0);
	state.publish(state.diagnostics);
}

export function diagnosticPhase(phase: string) {
	const state = context.getStore();
	if (!state) return;
	const now = Math.round(performance.now() - state.startedAt);
	if (state.phaseSpan) state.phaseSpan.durationMs = now - state.phaseSpan.startMs;
	state.phaseSpan = { name: phase, startMs: now };
	state.diagnostics.spans.push(state.phaseSpan);
	state.diagnostics.phase = phase;
	state.publish(state.diagnostics);
}

export function diagnosticFailure() {
	const state = context.getStore();
	if (!state || state.diagnostics.failurePhase) return;
	state.diagnostics.failurePhase = state.diagnostics.phase;
	if (state.phaseSpan) state.phaseSpan.failed = true;
}

/** Spans are nested within runner phases; these figures must not be added to the phase total. */
const duration = (ms: number) => `${ms}ms`;

/** Parent-observed startup includes event delivery; a missing final event means execution is incomplete. */
export function completeDiagnostics(diagnostics: Diagnostics, wallMs: number, startupMs: number): Diagnostics {
	diagnostics.wallMs = Math.round(wallMs);
	diagnostics.startupMs = Math.round(startupMs);
	if (diagnostics.runnerMs === undefined) {
		diagnostics.incomplete = true;
		diagnostics.runnerMs = Math.max(0, diagnostics.wallMs - diagnostics.startupMs);
	}
	diagnostics.responseMs = Math.max(0, diagnostics.wallMs - diagnostics.startupMs - diagnostics.runnerMs);
	return diagnostics;
}

export function diagnosticLines(diagnostics: Diagnostics): string[] {
	const lines: string[] = [];
	if (diagnostics.wallMs !== undefined) {
		lines.push(
			`wall ${duration(diagnostics.wallMs)} · runner startup/IPC ${duration(diagnostics.startupMs ?? 0)} · runner${diagnostics.incomplete ? " (observed, incomplete)" : ""} ${duration(diagnostics.runnerMs ?? 0)} · response/exit ${duration(diagnostics.responseMs ?? 0)}`,
		);
	}
	if (diagnostics.spans.length) {
		lines.push("phase detail (nested measurements overlap):");
		lines.push(
			...diagnostics.spans
				.filter((span) => span.durationMs !== 0)
				.map(
					(span) =>
						`  ${span.name}: ${span.durationMs === undefined ? "incomplete" : duration(span.durationMs)}${span.failed ? " (failed)" : ""}`,
				),
		);
	}
	const counters = Object.entries(diagnostics.counters);
	if (counters.length) lines.push(counters.map(([name, value]) => `${name}: ${value}`).join(" · "));
	if (diagnostics.failurePhase) lines.push(`failed during: ${diagnostics.failurePhase}`);
	return lines;
}
