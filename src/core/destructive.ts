/**
 * Destructive classification (S35). The model does not get to decide this: the gate infers it from
 * the binary name and the argv. A class the model *declares* only adds a reason to pause; it can
 * never remove one.
 *
 * Bias, stated by the operator: when in doubt, pause. A false positive costs one confirmation; a
 * false negative crosses red line #2.
 */

export const DESTRUCTIVE_TECHNIQUES = new Set([
	"dos",
	"ddos",
	"brute-force",
	"bruteforce",
	"password-spray",
	"credential-stuffing",
	"credential-stuffing-spray",
	"fuzzing-flood",
	"flood",
]);

const BRUTE_FORCE_BINARIES = /(^|[\/\\])(hydra|medusa|ncrack|patator|crowbar|legba|john|hashcat|aircrack-ng)(\.exe)?$/i;
const FLOOD_FLAGS = /^(--?flood|--?dos|--?ddos)$/i;
const RATE_FLAGS = new Set(["-rate", "--rate", "--rate-limit", "-rl", "--rps", "-rps"]);
const CONCURRENCY_FLAGS = new Set(["-c", "--concurrency", "-t", "--threads", "-threads"]);
const WORDLIST_FLAGS = new Set(["-w", "--wordlist", "-P", "--passwords", "-p", "--pass"]);
const TAGS_FLAGS = new Set(["-tags", "--tags", "-t", "--template-tags"]);
const TARGET_FLAGS = new Set(["-u", "--url", "-target", "--target", "-host", "--host"]);
const PASSWORD_WORDLIST = /(pass|cred|pw|rockyou|spray|logins?)/i;
const LOGIN_PATH = /\/(login|signin|sign-in|auth|authenticate|session|token|oauth|admin\/login)/i;
const DANGEROUS_TAGS = /(^|,)\s*(dos|fuzz|fuzzing|intrusive|brute|bruteforce|spray)\s*(,|$)/i;

export interface DestructiveInput {
	tool: string;
	args: string[];
	technique?: string;
	scopeRateRps: number | null;
	forbidden?: string[];
	targetPath?: string;
}

export interface DestructiveVerdict {
	destructive: boolean;
	reason: string | null;
	signals: string[];
}

function numericValue(args: string[], flags: Set<string>, shortWithValue: boolean): number | null {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const equals = token.indexOf("=");
		const name = equals >= 0 && token.startsWith("--") ? token.slice(0, equals) : token;
		const inlineValue = equals >= 0 ? token.slice(equals + 1) : null;
		if (flags.has(name)) {
			const raw = inlineValue ?? args[index + 1];
			if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
			continue;
		}
		// Attached short form such as `-c50`.
		if (shortWithValue && /^-[a-z]\d+$/i.test(token)) {
			const short = token.slice(0, 2);
			if (flags.has(short)) return Number(token.slice(2));
		}
	}
	return null;
}

function stringValue(args: string[], flags: Set<string>): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		const equals = token.indexOf("=");
		const name = equals >= 0 && token.startsWith("--") ? token.slice(0, equals) : token;
		if (!flags.has(name)) continue;
		const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
		if (typeof value === "string") return value;
	}
	return null;
}

export function classifyDestructive(input: DestructiveInput): DestructiveVerdict {
	const signals: string[] = [];
	const strong: string[] = [];
	const weak: string[] = [];
	const binary = input.tool.trim();
	const targetPath = input.targetPath ?? stringValue(input.args, TARGET_FLAGS) ?? "";

	if (BRUTE_FORCE_BINARIES.test(binary)) strong.push(`binary "${binary}" is a credential brute-force tool`);

	if (input.args.some((arg) => FLOOD_FLAGS.test(arg))) strong.push("flooding flag in argv");
	if (input.args.some((arg) => /rate[-_]?limit\s*[=\s]?0\b/i.test(arg))) strong.push("rate limited to zero means no limit");

	const tags = stringValue(input.args, TAGS_FLAGS);
	if (tags !== null && DANGEROUS_TAGS.test(tags)) strong.push(`nuclei tags "${tags}" include an intrusive class`);

	const wordlist = stringValue(input.args, WORDLIST_FLAGS);
	if (wordlist !== null && PASSWORD_WORDLIST.test(wordlist)) {
		if (LOGIN_PATH.test(targetPath) || BRUTE_FORCE_BINARIES.test(binary)) {
			strong.push(`password wordlist "${wordlist}" against a login/session endpoint`);
		} else {
			weak.push(`password-looking wordlist "${wordlist}"`);
		}
	}

	const rate = numericValue(input.args, RATE_FLAGS, true);
	if (rate !== null) {
		if (rate === 0) strong.push("rate limited to zero means no limit");
		else if (input.scopeRateRps === null) strong.push(`explicit rate ${rate} with no rate declared by the program`);
		else if (rate > input.scopeRateRps) strong.push(`rate ${rate} exceeds the program rate of ${input.scopeRateRps}/s`);
	}

	const concurrency = numericValue(input.args, CONCURRENCY_FLAGS, true);
	if (concurrency !== null && concurrency > 20) weak.push(`concurrency ${concurrency} is aggressive`);

	if (LOGIN_PATH.test(targetPath)) weak.push("target is a login/session endpoint");

	const forbidden = (input.forbidden ?? []).filter((item) => DESTRUCTIVE_TECHNIQUES.has(item));
	if (input.technique !== undefined && forbidden.includes(input.technique)) {
		strong.push(`class "${input.technique}" is on the program's forbidden list`);
	} else if (input.technique !== undefined && DESTRUCTIVE_TECHNIQUES.has(input.technique)) {
		strong.push(`declared class "${input.technique}" is destructive`);
	}

	signals.push(...strong, ...weak);

	// Ambiguity resolves toward pausing: two weak signals together are treated as destructive.
	if (strong.length > 0) return { destructive: true, reason: strong[0] ?? "destructive signal", signals };
	if (weak.length >= 2) return { destructive: true, reason: `ambiguous combination: ${weak.join("; ")}`, signals };
	return { destructive: false, reason: null, signals };
}
