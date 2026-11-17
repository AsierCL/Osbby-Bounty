/**
 * One header file format for the whole tool: `Name: value` per line, `#` comments, blank lines
 * ignored. It is shared by the single session file (S97) and the per-role files (S106) so the two
 * cannot drift into two slightly different parsers.
 */

export interface HeaderLine {
	name: string;
	value: string;
}

export function parseHeaderLines(text: string): HeaderLine[] {
	const headers: HeaderLine[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const name = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (name.length === 0) continue;
		headers.push({ name, value });
	}
	return headers;
}

/** Duplicates are legal on the wire but usually a mistake in a hand-written file; report them. */
export function duplicatedHeaderNames(headers: HeaderLine[]): string[] {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const header of headers) {
		const key = header.name.toLowerCase();
		if (seen.has(key)) duplicated.add(header.name);
		seen.add(key);
	}
	return [...duplicated];
}
