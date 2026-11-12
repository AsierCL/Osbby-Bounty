/**
 * Egress proxy tests (S18). Everything here is real sockets on 127.0.0.1 and nothing else: no DNS,
 * no external host, no reserved address.
 *
 * The two assertions that matter are:
 *   - an out-of-scope request never reaches the upstream server;
 *   - an out-of-scope CONNECT never calls the dialer, so no packet can leave.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";

import { createEgressProxy } from "../src/core/proxy.ts";
import { createRateLimiter } from "../src/core/ratelimit.ts";
import { parseScope } from "../src/core/scope.ts";

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("no port"));
				return;
			}
			resolve(address.port);
		});
	});
}

function scopeFor(port: number, extra = "") {
	const parsed = parseScope(
		`program: lab\nlab: true\nauthorized_on: 2026-11-01\nin_scope:\n  - 127.0.0.1:${port}\nlimits:\n  rate_rps: 50\n${extra}`,
	);
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) throw new Error("unreachable");
	return parsed.policy;
}

function proxiedGet(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port: proxyPort, path: absoluteUrl, method: "GET" } as never,
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function connectThrough(proxyPort: number, target: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let head = "";
		const raw = netConnect(proxyPort, "127.0.0.1", () => {
			raw.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`);
		});
		raw.on("data", (chunk) => {
			head += chunk.toString();
			raw.destroy();
			resolve(head);
		});
		raw.on("error", reject);
		raw.on("close", () => resolve(head));
	});
}

test("an in-scope request is forwarded and logged", async () => {
	const upstream = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("upstream-ok");
	});
	const upstreamPort = await listen(upstream);
	const entries: unknown[] = [];
	const proxy = createEgressProxy({
		scope: scopeFor(upstreamPort),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: (entry) => {
			entries.push(entry);
		},
	});
	const proxyPort = await proxy.listen();

	try {
		const response = await proxiedGet(proxyPort, `http://127.0.0.1:${upstreamPort}/x?y=1`);
		assert.equal(response.status, 200);
		assert.equal(response.body, "upstream-ok");
		const entry = proxy.entries()[0];
		assert.equal(entry?.allowed, true);
		assert.equal(entry?.host, "127.0.0.1");
		assert.equal(entry?.port, upstreamPort);
		assert.equal(entry?.path, "/x");
		assert.ok(entries.length === 1);
	} finally {
		await proxy.close();
		upstream.close();
	}
});

test("an out-of-scope port is refused and never reaches the upstream", async () => {
	let reached = 0;
	const upstream = createServer((_req, res) => {
		reached += 1;
		res.end("should-not-happen");
	});
	const upstreamPort = await listen(upstream);
	const otherUpstream = createServer((_req, res) => {
		reached += 1;
		res.end("other");
	});
	const otherPort = await listen(otherUpstream);

	const proxy = createEgressProxy({
		scope: scopeFor(upstreamPort),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: () => {},
	});
	const proxyPort = await proxy.listen();

	try {
		const response = await proxiedGet(proxyPort, `http://127.0.0.1:${otherPort}/x`);
		assert.equal(response.status, 403);
		assert.match(response.body, /egress denied/);
		assert.equal(reached, 0, "an out-of-scope request reached a local upstream");
		const entry = proxy.entries()[0];
		assert.equal(entry?.allowed, false);
		assert.equal(entry?.reason, "not in scope");
	} finally {
		await proxy.close();
		upstream.close();
		otherUpstream.close();
	}
});

test("a non-absolute request URI is rejected", async () => {
	const upstream = createServer((_req, res) => res.end("x"));
	const upstreamPort = await listen(upstream);
	const proxy = createEgressProxy({
		scope: scopeFor(upstreamPort),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: () => {},
	});
	const proxyPort = await proxy.listen();
	try {
		const response = await proxiedGet(proxyPort, "/relative");
		assert.equal(response.status, 400);
	} finally {
		await proxy.close();
		upstream.close();
		upstream.closeAllConnections?.();
	}
});

test("an out-of-scope CONNECT is refused and the dialer is never called", async () => {
	let dialed = 0;
	const proxy = createEgressProxy({
		scope: scopeFor(1),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: () => {},
		dial: () => {
			dialed += 1;
			return new PassThrough() as unknown as Socket;
		},
	});
	const proxyPort = await proxy.listen();
	try {
		const head = await connectThrough(proxyPort, "203.0.113.9:443");
		assert.match(head, /403 Forbidden|503|429|400/);
		assert.equal(dialed, 0, "the dialer was called for an out-of-scope CONNECT");
		const entry = proxy.entries()[0];
		assert.equal(entry?.kind, "connect");
		assert.equal(entry?.allowed, false);
	} finally {
		await proxy.close();
	}
});

test("an in-scope CONNECT is established through the injected dialer", async () => {
	let dialed = 0;
	const proxy = createEgressProxy({
		scope: scopeFor(8443),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: () => {},
		dial: () => {
			dialed += 1;
			return new PassThrough() as unknown as Socket;
		},
	});
	const proxyPort = await proxy.listen();
	try {
		const head = await connectThrough(proxyPort, "127.0.0.1:8443");
		assert.match(head, /200 Connection Established/);
		assert.equal(dialed, 1);
	} finally {
		await proxy.close();
	}
});

test("the proxy honours the daily cap instead of queueing", async () => {
	const upstream = createServer((_req, res) => res.end("ok"));
	const upstreamPort = await listen(upstream);
	const proxy = createEgressProxy({
		scope: scopeFor(upstreamPort),
		limiter: createRateLimiter({ defaultRps: 50, dailyCap: 1 }, () => Date.now()),
		log: () => {},
	});
	const proxyPort = await proxy.listen();
	try {
		const first = await proxiedGet(proxyPort, `http://127.0.0.1:${upstreamPort}/a`);
		assert.equal(first.status, 200);
		const second = await proxiedGet(proxyPort, `http://127.0.0.1:${upstreamPort}/b`);
		assert.equal(second.status, 429);
		const entries = proxy.entries();
		assert.equal(entries[1]?.reason, "rate limited");
	} finally {
		await proxy.close();
		upstream.close();
	}
});

test("log entries carry no request headers", async () => {
	const upstream = createServer((_req, res) => res.end("ok"));
	const upstreamPort = await listen(upstream);
	const proxy = createEgressProxy({
		scope: scopeFor(upstreamPort),
		limiter: createRateLimiter({ defaultRps: 50 }, () => Date.now()),
		log: () => {},
	});
	const proxyPort = await proxy.listen();
	try {
		await new Promise<void>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: proxyPort,
					path: `http://127.0.0.1:${upstreamPort}/`,
					headers: { cookie: "session=topsecret" },
				} as never,
				(response) => {
					response.resume();
					response.on("end", () => resolve());
				},
			);
			req.on("error", reject);
			req.end();
		});
		assert.ok(!JSON.stringify(proxy.entries()).includes("topsecret"));
	} finally {
		await proxy.close();
		upstream.close();
	}
});
