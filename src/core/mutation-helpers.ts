/**
 * S90 (S98 in this thread): mass assignment helper.
 *
 * The tool does not guess silently: it merges a short, documented set of escalation properties into a
 * JSON body and returns exactly which keys it added, so the evidence records the mutation and the agent
 * (or the human) can see it. Only JSON objects are touched; anything else is left alone.
 */
const MASS_ASSIGNMENT_KEYS: Record<string, unknown> = {
	isAdmin: true,
	role: "admin",
	verified: true,
	isStaff: true,
	permissions: ["all"],
	emailVerified: true,
};

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--json"]);

export interface MassAssignmentResult {
	args: string[];
	added: string[];
	/** The body that was sent, so the evidence can show it (the model already wrote it). */
	body: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function injectMassAssignment(args: string[]): MassAssignmentResult {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		let valueIndex = -1;
		let value: string | undefined;
		if (DATA_FLAGS.has(token)) {
			valueIndex = index + 1;
			value = args[valueIndex];
		} else {
			const equals = token.indexOf("=");
			const name = equals > 0 && token.startsWith("--") ? token.slice(0, equals) : token;
			if (DATA_FLAGS.has(name)) value = token.slice(equals + 1);
		}
		if (value === undefined) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			continue;
		}
		if (!isPlainObject(parsed)) continue;
		const added: string[] = [];
		for (const [key, next] of Object.entries(MASS_ASSIGNMENT_KEYS)) {
			if (key in parsed) continue;
			(parsed as Record<string, unknown>)[key] = next;
			added.push(key);
		}
		if (added.length === 0) return { args, added, body: value };
		const body = JSON.stringify(parsed);
		const patched = [...args];
		if (valueIndex >= 0) patched[valueIndex] = body;
		else {
			const equals = token.indexOf("=");
			patched[index] = `${token.slice(0, equals)}=${body}`;
		}
		return { args: patched, added, body };
	}
	return { args, added: [], body: null };
}

/** S90: a controlled burst; the cap keeps it a test, never a flood. */
export const MAX_BURST = 12;

export function normalizeBurst(burst: number | undefined): number {
	if (burst === undefined || !Number.isFinite(burst)) return 1;
	return Math.min(Math.max(Math.floor(burst), 1), MAX_BURST);
}
