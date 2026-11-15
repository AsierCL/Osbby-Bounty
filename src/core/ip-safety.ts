/**
 * S87: the security question that actually matters for a name in scope is not "is the CDN's name in
 * my scope", it is "where does it end up". A name in scope that resolves to loopback, a private range,
 * link-local or the cloud metadata address must be refused: that is the SSRF shape (DNS rebinding
 * included), and a provider CNAME does not make it safe.
 *
 * Error direction: anything unclassifiable is `unknown`, and the gate treats `unknown` as internal.
 */
export type AddressKind = "public" | "loopback" | "private" | "link-local" | "unique-local" | "unspecified" | "metadata" | "unknown";

const METADATA = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

function ipv4Kind(address: string): AddressKind | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
	const [a, b] = octets as [number, number, number, number];
	if (a === 127) return "loopback";
	if (a === 10) return "private";
	if (a === 172 && b >= 16 && b <= 31) return "private";
	if (a === 192 && b === 168) return "private";
	if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
	if (a === 169 && b === 254) return "link-local";
	if (a === 0) return "unspecified";
	return "public";
}

function ipv6Kind(address: string): AddressKind | null {
	const lower = address.toLowerCase();
	if (!lower.includes(":")) return null;
	// IPv4-mapped: ::ffff:127.0.0.1 and friends inherit the IPv4 verdict.
	const mapped = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
	if (mapped !== null) {
		const inner = ipv4Kind(mapped[1] as string);
		return inner === "public" ? "public" : inner;
	}
	const compressed = lower.split("%")[0] ?? lower;
	const expanded = expandIpv6(compressed);
	if (expanded === null) return null;
	const [first, second] = expanded as [number, number, ...number[]];
	if (expanded.every((group) => group === 0)) return "unspecified";
	if (expanded.slice(0, 7).every((group) => group === 0) && expanded[7] === 1) return "loopback";
	if ((first & 0xfe00) === 0xfc00) return "unique-local";
	if ((first & 0xffc0) === 0xfe80) return "link-local";
	if (first === 0x2001 && second === 0x0db8) return "public"; // documentation range, not internal
	return "public";
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when it is not one. */
function expandIpv6(address: string): number[] | null {
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
	const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : [];
	const toGroup = (part: string): number | null => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : null);
	const headGroups = head.map(toGroup);
	const tailGroups = tail.map(toGroup);
	if ([...headGroups, ...tailGroups].some((group) => group === null)) return null;
	const missing = 8 - (headGroups.length + tailGroups.length);
	if (missing < 0) return null;
	if (halves.length === 1 && missing !== 0) return null;
	return [...(headGroups as number[]), ...Array.from({ length: missing }, () => 0), ...(tailGroups as number[])];
}

export function classifyAddress(address: string): AddressKind {
	const trimmed = address.trim().replace(/^\[|\]$/g, "");
	if (METADATA.has(trimmed.toLowerCase())) return "metadata";
	const v4 = ipv4Kind(trimmed);
	if (v4 !== null) return v4;
	const v6 = ipv6Kind(trimmed);
	if (v6 !== null) return v6;
	return "unknown";
}

/** True when the gate must refuse the address unless the scope explicitly allows a lab's private net. */
export function isInternalAddress(address: string): boolean {
	const kind = classifyAddress(address);
	return kind !== "public";
}
