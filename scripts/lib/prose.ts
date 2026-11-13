/**
 * S76/task 7: extracting the reporter's JSON from a child's raw output, with a diagnosis instead of a
 * silent null. The runner's output can carry several text fragments (an intro message, the answer),
 * so a naive first-`{`/last-`}` slice is not enough.
 */

export interface Extracted<T> {
	value: T | null;
	strategy: string;
	diagnosis: string;
}

function tryParse(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Balanced `{...}` objects in order of appearance, respecting strings and escapes. */
function objects(text: string): string[] {
	const found: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] as string;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				found.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}
	return found;
}

export function extractProse<T = Record<string, unknown>>(output: string): Extracted<T> {
	const stripped = output.replace(/```[a-zA-Z]*/g, "").trim();
	const whole = tryParse(stripped) as T | null;
	if (whole !== null) return { value: whole, strategy: "whole", diagnosis: "" };

	const candidates = objects(stripped);
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const parsed = tryParse(candidates[index] as string) as T | null;
		if (parsed !== null && typeof parsed === "object") {
			return { value: parsed, strategy: candidates.length === 1 ? "single-object" : `last-of-${candidates.length}`, diagnosis: "" };
		}
	}
	const head = stripped.slice(0, 120).replace(/\s+/g, " ");
	return {
		value: null,
		strategy: "none",
		diagnosis: `sin objeto JSON parseable (${candidates.length} bloque(s) con llaves, ${stripped.length} caracteres; empieza: ${JSON.stringify(head)})`,
	};
}
