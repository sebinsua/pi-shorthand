import { expect, test } from "bun:test";
import { ProgramClock } from "../program-clock.ts";

function fakeClock(allowanceMs = 60_000) {
	let now = 0;
	const clock = new ProgramClock(allowanceMs, () => now);
	return { clock, advance: (ms: number) => (now += ms) };
}

test("time inside a helper does not count toward the timeout", () => {
	const { clock, advance } = fakeClock();
	advance(100);
	clock.helperStarted(1);
	advance(5_000);
	expect(clock.elapsedMs()).toBe(100);
	clock.helperFinished(1);
	advance(200);
	expect(clock.elapsedMs()).toBe(300);
	expect(clock.excludedMs()).toBe(5_000);
});

test("overlapping helpers are excluded once", () => {
	const { clock, advance } = fakeClock();
	clock.helperStarted(1);
	advance(1_000);
	clock.helperStarted(2);
	advance(1_000);
	clock.helperFinished(1);
	advance(1_000);
	clock.helperFinished(2);
	advance(500);
	expect(clock.excludedMs()).toBe(3_000);
	expect(clock.elapsedMs()).toBe(500);
});

test("a helper that never finishes stops pausing at the allowance", () => {
	const { clock, advance } = fakeClock(60_000);
	clock.helperStarted(1);
	advance(90_000);
	expect(clock.excludedMs()).toBe(60_000);
	expect(clock.elapsedMs()).toBe(30_000);
});

test("an unknown finish does not resume a running pause", () => {
	const { clock, advance } = fakeClock();
	clock.helperStarted(1);
	clock.helperFinished(7);
	advance(1_000);
	expect(clock.elapsedMs()).toBe(0);
});
