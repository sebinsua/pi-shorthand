/** Preserve existing UTF-8 text conventions at the transaction boundary, regardless of writer. */
export function preserveTextFormat(before: Uint8Array, after: Uint8Array): Uint8Array {
	if (before.includes(0) || after.includes(0)) return after;
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let original: string;
	let updated: string;
	try {
		original = decoder.decode(before);
		updated = decoder.decode(after);
	} catch {
		return after;
	}
	const written = updated;
	const endings = new Set(original.match(/\r\n|\r|\n/g));
	// A mixed file has no single convention to infer. Do not normalize it wholesale.
	if (endings.size === 1) {
		const ending = [...endings][0];
		updated = updated.replace(/\r\n|\r|\n/g, ending);
	}
	if (original.startsWith("\uFEFF") && !updated.startsWith("\uFEFF")) updated = "\uFEFF" + updated;
	return updated === written ? after : new TextEncoder().encode(updated);
}
