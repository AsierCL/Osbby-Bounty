/**
 * S87: the DNS answer the gate needs, shared by every process that runs a bounty session (the Pi
 * extension and the background recon job). A resolver failure is an error; a name with no address is
 * an error; "no record" is a valid answer.
 */
import { resolve4, resolve6, resolveCname } from "node:dns/promises";
import { isIP } from "node:net";

const SOFT_CODES = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP", "ESERVFAIL", "EREFUSED"]);

export async function resolveForGate(host: string): Promise<{ cname: string[]; addresses: string[] } | { error: string }> {
	if (isIP(host) !== 0 || host === "localhost") return { cname: [], addresses: [] };
	const codeOf = (error: unknown) => (error as { code?: string }).code ?? "unknown";

	let cname: string[] = [];
	try {
		cname = await resolveCname(host);
	} catch (error) {
		const code = codeOf(error);
		if (!SOFT_CODES.has(code)) return { error: code };
	}

	const addresses: string[] = [];
	for (const resolve of [resolve4, resolve6]) {
		try {
			addresses.push(...(await resolve(host)));
		} catch (error) {
			const code = codeOf(error);
			if (!SOFT_CODES.has(code)) return { error: code };
		}
	}
	if (addresses.length === 0) return { error: `no address records for ${host}` };
	return { cname, addresses };
}
