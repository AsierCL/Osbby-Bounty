/**
 * S91: models repeat themselves. A child that answers a JSON array three times is not a broken
 * annotator, it is a model quirk; the code should take the last complete array instead of failing.
 */
function balancedBlocks(text: string, open: string, close: string): string[] {
	const blocks: string[] = [];
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
		else if (char === open) {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === close) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				blocks.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}
	return blocks;
}

/** Parses the last complete JSON array in the text, or null. */
export function extractJsonArray<T = unknown>(text: string): T[] | null {
	const blocks = balancedBlocks(text.replace(/```[a-zA-Z]*/g, ""), "[", "]");
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		try {
			const parsed = JSON.parse(blocks[index] as string);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {
			continue;
		}
	}
	return null;
}
