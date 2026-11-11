/**
 * Egress proxy (S9 C2): every outbound request from the agent is supposed to pass through here.
 *
 * It is the second half of the enforcement story. `bounty_run` decides before spawning a tool; the
 * proxy decides per connection, which is what catches tools that open their own sockets. Both use the
 * same scope matcher and the same limiter, so a decision cannot disagree between them.
 *
 * What it does NOT do: it cannot stop a process that ignores `HTTP_PROXY`. That is why ADR-0003 pairs
 * this proxy with an OS-level egress rule. The proxy is necessary, not sufficient.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

import type { Limiter } from "./ratelimit.ts";
import { evaluate, type ScopePolicy } from "./scope.ts";
import { parseLooseHost } from "./target.ts";

export interface ProxyLogEntry {
	ts: string;
	kind: "request" | "connect";
	method: string;
	host: string | null;
	port: number | null;
	path: string | null;
	allowed: boolean;
	reason?: string;
	detail?: string;
	delayMs?: number;
}

export interface EgressProxyOptions {
	scope: ScopePolicy;
	limiter: Limiter;
	log: (entry: ProxyLogEntry) => Promise<void> | void;
	now?: () => number;
	/** Injected so tests never touch the network. */
	dial?: (host: string, port: number) => Socket;
}

export interface EgressProxy {
	server: Server;
	listen(port?: number, host?: string): Promise<number>;
	close(): Promise<void>;
	entries(): ProxyLogEntry[];
}

interface Decision {
	host: string;
	port: number;
	allowed: boolean;
	reason?: string;
	detail?: string;
}

function decide(scope: ScopePolicy, rawHost: string, port: number, path: string): Decision {
	const parsed = parseLooseHost(rawHost);
	if (parsed === null) {
		return { host: rawHost, port, allowed: false, reason: "unparseable host" };
	}
	const verdict = evaluate(scope, { host: parsed.host, path, port });
	if (verdict.verdict === "in") return { host: parsed.host, port, allowed: true };
	if (verdict.verdict === "out") {
		return { host: parsed.host, port, allowed: false, reason: "out of scope", detail: `rule "${verdict.rule}" excludes it` };
	}
	return { host: parsed.host, port, allowed: false, reason: "not in scope", detail: verdict.reason };
}

const HOP_BY_HOP = new Set([
	"proxy-connection",
	"proxy-authorization",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
]);

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
	const now = options.now ?? (() => Date.now());
	const dial = options.dial ?? ((host: string, port: number) => netConnect({ host, port }));
	const entries: ProxyLogEntry[] = [];

	async function record(entry: ProxyLogEntry): Promise<void> {
		entries.push(entry);
		await options.log(entry);
	}

	function deny(res: ServerResponse | IncomingMessage, entry: ProxyLogEntry): void {
		const text = `egress denied: ${entry.reason ?? "not allowed"}${entry.detail === undefined ? "" : ` (${entry.detail})`}\n`;
		if ("writeHead" in res) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
			res.end(text);
			return;
		}
		res.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
		res.destroy();
	}

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const rawUrl = req.url ?? "";
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(rawUrl);
		} catch {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("egress proxy requires an absolute-form request URI\n");
			return;
		}
		const port = parsedUrl.port === "" ? (parsedUrl.protocol === "https:" ? 443 : 80) : Number(parsedUrl.port);
		const decision = decide(options.scope, parsedUrl.hostname, port, parsedUrl.pathname);
		const entry: ProxyLogEntry = {
			ts: new Date(now()).toISOString(),
			kind: "request",
			method: req.method ?? "GET",
			host: decision.host,
			port: decision.port,
			path: parsedUrl.pathname,
			allowed: decision.allowed,
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
			...(decision.detail === undefined ? {} : { detail: decision.detail }),
		};

		if (!decision.allowed) {
			await record(entry);
			deny(res, entry);
			return;
		}

		const reservation = options.limiter.reserve(decision.host);
		if (!reservation.allowed) {
			entry.allowed = false;
			entry.reason = "rate limited";
			entry.detail = reservation.reason;
			await record(entry);
			res.writeHead(429, { "content-type": "text/plain" });
			res.end("rate limited\n");
			return;
		}
		if (reservation.delayMs > 0) {
			entry.delayMs = reservation.delayMs;
			await new Promise((resolve) => setTimeout(resolve, reservation.delayMs));
		}

		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined) continue;
			if (HOP_BY_HOP.has(name.toLowerCase())) continue;
			headers[name] = value;
		}
		headers.host = parsedUrl.host;

		const upstream = httpRequest(
			{
				host: parsedUrl.hostname,
				port,
				path: `${parsedUrl.pathname}${parsedUrl.search}`,
				method: req.method,
				headers,
			} as never,
			(upstreamResponse) => {
				const responseHeaders: Record<string, string | string[]> = {};
				for (const [name, value] of Object.entries(upstreamResponse.headers)) {
					if (value === undefined) continue;
					if (HOP_BY_HOP.has(name.toLowerCase())) continue;
					responseHeaders[name] = value;
				}
				res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				upstreamResponse.pipe(res);
			},
		);
		upstream.on("error", (error) => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`upstream error: ${error.message}\n`);
		});
		req.pipe(upstream);
		await record(entry);
	}

	function handleConnect(req: IncomingMessage, clientSocket: Socket): void {
		const target = req.url ?? "";
		const separator = target.lastIndexOf(":");
		if (separator <= 0) {
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const rawHost = target.slice(0, separator);
		const port = Number(target.slice(separator + 1));
		const decision = decide(options.scope, rawHost, port, "/");
		const entry: ProxyLogEntry = {
			ts: new Date(now()).toISOString(),
			kind: "connect",
			method: "CONNECT",
			host: decision.host,
			port: decision.port,
			path: null,
			allowed: decision.allowed,
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
			...(decision.detail === undefined ? {} : { detail: decision.detail }),
		};

		if (!decision.allowed) {
			void record(entry);
			clientSocket.end(`HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n`);
			return;
		}

		const reservation = options.limiter.reserve(decision.host);
		if (!reservation.allowed) {
			entry.allowed = false;
			entry.reason = "rate limited";
			entry.detail = reservation.reason;
			void record(entry);
			clientSocket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n");
			return;
		}

		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		const upstream = dial(rawHost, port);
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => upstream.destroy());
		clientSocket.pipe(upstream);
		upstream.pipe(clientSocket);
		void record(entry);
	}

	const server = createServer((req, res) => {
		void handleRequest(req, res);
	});
	server.on("connect", handleConnect);

	return {
		server,
		listen(port = 0, host = "127.0.0.1") {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					const address = server.address();
					if (address === null || typeof address === "string") {
						reject(new Error("proxy did not bind a TCP port"));
						return;
					}
					resolve(address.port);
				});
			});
		},
		close() {
			return new Promise((resolve) => {
				server.close(() => resolve());
				// Keep-alive sockets keep `close()` pending forever; the proxy owns them.
				server.closeAllConnections?.();
			});
		},
		entries() {
			return [...entries];
		},
	};
}
