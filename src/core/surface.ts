/**
 * S1/T4: surface extraction runs on artifacts that are ALREADY captured. It never touches the network:
 * the bundle or schema reached `work/<program>/files/` through `bounty_run`, and this module turns it
 * into endpoints and parameters for the board.
 *
 * Two properties matter more than recall:
 *
 * 1. **No values, only names.** A secret found in a bundle is reported by location and pattern, never
 *    by value: the board is model-visible, and a model-visible credential is a leaked credential.
 * 2. **Bounded output.** A minified bundle can yield thousands of paths; the extractor caps what it
 *    returns and says how many it dropped, so the board stays a map and not a dump.
 */
import { duplicatedHeaderNames } from "./headers.ts";

export type SurfaceKind = "javascript" | "openapi" | "graphql";

export interface SurfaceEndpoint {
	path: string;
	method: string | null;
	/** Query or body parameter names, never values. */
	params: string[];
	/** Where it came from: the file, plus a line-ish hint when it is cheap to produce. */
	source: string;
}

export interface SurfaceSecret {
	/** Location inside the artifact, for a human to look. */
	location: string;
	/** What kind of thing it looks like, never the value. */
	pattern: string;
}

export interface SurfaceReport {
	kind: SurfaceKind;
	endpoints: SurfaceEndpoint[];
	secrets: SurfaceSecret[];
	/** Entries dropped by the cap, so "nothing else" is never claimed. */
	dropped: number;
}

export const MAX_SURFACE_ENTRIES = 200;
export const MAX_SURFACE_BYTES = 8 * 1024 * 1024;

/** Static assets are not an attack surface; extracting them is noise. */
const STATIC_EXTENSIONS = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp4|webp|avif)(?:$|[?#])/i;
const ROUTE_RE = /["'`](\/(?:api|graphql|v\d+|internal|admin|auth|oauth|users?|accounts?|orders?|invoices?|payments?|uploads?|files?|webhooks?)(?=[/?#"'`]|$)(?:[/?][A-Za-z0-9._\-/{}$:?=&%]*)?)/g;
const ABSOLUTE_RE = /["'`](https?:\/\/[A-Za-z0-9._\-]+(?::\d+)?\/[A-Za-z0-9._\-/{}$:?=&%]*)/g;
const SECRET_RE = /(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["'`]([A-Za-z0-9_\-./+=]{12,})["'`]/gi;
const GRAPHQL_FIELD_RE = /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function queryParams(path: string): string[] {
	const index = path.indexOf("?");
	if (index === -1) return [];
	return [...new Set(path.slice(index + 1).split("&").map((pair) => pair.split("=")[0]?.trim() ?? "").filter((name) => name.length > 0))];
}

function cleanPath(raw: string): string {
	// The path is what the board stores; the query belongs to `params`, never to the path.
	const withoutQuery = (raw.split("?")[0] ?? raw).split("#")[0] ?? raw;
	return withoutQuery.replace(/\$\{[^}]*\}/g, ":param");
}

function cap<T>(items: T[]): { kept: T[]; dropped: number } {
	return items.length <= MAX_SURFACE_ENTRIES ? { kept: items, dropped: 0 } : { kept: items.slice(0, MAX_SURFACE_ENTRIES), dropped: items.length - MAX_SURFACE_ENTRIES };
}

function dedupeEndpoints(endpoints: SurfaceEndpoint[]): SurfaceEndpoint[] {
	const seen = new Map<string, SurfaceEndpoint>();
	for (const endpoint of endpoints) {
		const key = `${endpoint.method ?? "ANY"} ${endpoint.path}`;
		const existing = seen.get(key);
		if (existing === undefined) {
			seen.set(key, endpoint);
			continue;
		}
		existing.params = [...new Set([...existing.params, ...endpoint.params])];
	}
	return [...seen.values()];
}

export function extractFromJavaScript(text: string, source: string): SurfaceReport {
	const endpoints: SurfaceEndpoint[] = [];
	for (const match of text.matchAll(ROUTE_RE)) {
		const raw = match[1];
		if (raw === undefined) continue;
		const path = cleanPath(raw);
		if (STATIC_EXTENSIONS.test(path)) continue;
		endpoints.push({ path, method: null, params: queryParams(raw), source });
	}
	for (const match of text.matchAll(ABSOLUTE_RE)) {
		const raw = match[1];
		if (raw === undefined) continue;
		let path: string;
		try {
			path = cleanPath(new URL(raw).pathname);
		} catch {
			continue;
		}
		if (STATIC_EXTENSIONS.test(path) || path === "/") continue;
		endpoints.push({ path, method: null, params: queryParams(raw), source });
	}

	const secrets: SurfaceSecret[] = [];
	for (const match of text.matchAll(SECRET_RE)) {
		const value = match[1];
		if (value === undefined) continue;
		const key = match[0].split(/[:=]/)[0]?.trim() ?? "secret";
		// The location is the key and an offset; the value never leaves this function.
		secrets.push({ location: `${source}@${match.index ?? 0}`, pattern: `${key} = <redacted>` });
	}

	const unique = dedupeEndpoints(endpoints);
	const capped = cap(unique);
	return { kind: "javascript", endpoints: capped.kept, secrets, dropped: capped.dropped };
}

interface OpenApiDocument {
	openapi?: unknown;
	swagger?: unknown;
	paths?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenAPI/Swagger: the schema already declares the surface, so the extraction is a read, not a guess.
 * `parameters` at the path level and at the operation level are merged, names only.
 */
export function extractFromOpenApi(text: string, source: string): SurfaceReport | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const doc = parsed as OpenApiDocument;
	if (doc.openapi === undefined && doc.swagger === undefined) return null;
	if (!isRecord(doc.paths)) return null;

	const endpoints: SurfaceEndpoint[] = [];
	for (const [rawPath, pathItem] of Object.entries(doc.paths)) {
		if (!isRecord(pathItem)) continue;
		const pathParams = namesOf(pathItem.parameters);
		for (const [method, operation] of Object.entries(pathItem)) {
			if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
			const opParams = isRecord(operation) ? namesOf(operation.parameters) : [];
			endpoints.push({ path: rawPath, method: method.toUpperCase(), params: [...new Set([...pathParams, ...opParams])], source });
		}
	}

	const capped = cap(dedupeEndpoints(endpoints));
	return { kind: "openapi", endpoints: capped.kept, secrets: [], dropped: capped.dropped };
}

function namesOf(parameters: unknown): string[] {
	const list = Array.isArray(parameters) ? parameters : [];
	const names: string[] = [];
	for (const parameter of list) {
		if (!isRecord(parameter)) continue;
		const name = typeof parameter.name === "string" ? parameter.name : undefined;
		if (name !== undefined && name.length > 0) names.push(name);
	}
	return names;
}

/**
 * GraphQL introspection: queries and mutations are the surface. Fields are the parameters.
 */
export function extractFromGraphql(text: string, source: string): SurfaceReport | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const root = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
	if (!isRecord(root)) return null;
	const schema = root.__schema ?? root.schema;
	if (!isRecord(schema) || !Array.isArray(schema.types)) return null;

	const endpoints: SurfaceEndpoint[] = [];
	for (const type of schema.types) {
		if (!isRecord(type)) continue;
		const name = typeof type.name === "string" ? type.name : "";
		if (!/^(Query|Mutation)$/.test(name)) continue;
		const fields = Array.isArray(type.fields) ? type.fields : [];
		for (const field of fields) {
			if (!isRecord(field) || typeof field.name !== "string") continue;
			const args = Array.isArray(field.args) ? field.args : [];
			const params = args.flatMap((arg) => (isRecord(arg) && typeof arg.name === "string" ? [arg.name] : []));
			endpoints.push({ path: `${name}.${field.name}`, method: name === "Mutation" ? "MUTATION" : "QUERY", params, source });
		}
	}

	const capped = cap(dedupeEndpoints(endpoints));
	return { kind: "graphql", endpoints: capped.kept, secrets: [], dropped: capped.dropped };
}

/** Best-effort detection, then the matching extractor. Unknown text is treated as JavaScript. */
export function extractSurface(text: string, source: string): SurfaceReport {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{")) {
		const openApi = extractFromOpenApi(text, source);
		if (openApi !== null) return openApi;
		const graphql = extractFromGraphql(text, source);
		if (graphql !== null) return graphql;
	}
	return extractFromJavaScript(text, source);
}

export function summarizeSurface(report: SurfaceReport): string {
	const methods = new Map<string, number>();
	for (const endpoint of report.endpoints) {
		const key = endpoint.method ?? "ruta";
		methods.set(key, (methods.get(key) ?? 0) + 1);
	}
	const parts = [...methods.entries()].map(([key, count]) => `${count} ${key}`);
	const header = `${report.kind}: ${report.endpoints.length} endpoint(s)${parts.length === 0 ? "" : ` (${parts.join(", ")})`}, ${report.secrets.length} secreto(s) marcado(s)`;
	const dropped = report.dropped === 0 ? "" : `\n${report.dropped} entrada(s) descartadas por el tope de ${MAX_SURFACE_ENTRIES}.`;
	return `${header}${dropped}`;
}

/** The board payload for one endpoint: shape only. */
export function endpointBoardData(endpoint: SurfaceEndpoint): Record<string, unknown> {
	return {
		path: endpoint.path,
		...(endpoint.method === null ? {} : { method: endpoint.method }),
		...(endpoint.params.length === 0 ? {} : { params: endpoint.params }),
		source: endpoint.source,
	};
}
