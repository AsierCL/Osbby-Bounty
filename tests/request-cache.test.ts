/**
 * S6-S8: the cache exists so five agents do not hit the target five times for the same bundle, and so
 * the program's rate budget is spent once. These tests pin the two mechanisms (in-flight coalescing and
 * TTL on disk), the narrow cacheability rule, and the two ways out: bypassCache and the verifier's
 * environment, which must always see real traffic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequestCache, isIdempotentRead, methodFromArgs, requestSignature, statusOf } from "../src/core/request-cache.ts";
import { createSession } from "../src/pi/session.ts";

test("the signature normalizes the URL and never shares work across methods or auth", () => {
	const a = requestSignature("get", "https://A.Acme.com/api/x#frag", "");
	const b = requestSignature("GET", "https://a.acme.com/api/x", "");
	assert.equal(a, b);
	assert.notEqual(a, requestSignature("HEAD", "https://a.acme.com/api/x", ""));
	assert.notEqual(a, requestSignature("GET", "https://a.acme.com/api/x", "cookie: session=1"));
	assert.notEqual(a, requestSignature("GET", "https://a.acme.com/api/y", ""));
});

test("the method comes from argv, and curl's default is a GET", () => {
	assert.equal(methodFromArgs(["https://a.acme.com"]), "GET");
	assert.equal(methodFromArgs(["-X", "put", "https://a.acme.com"]), "PUT");
	assert.equal(methodFromArgs(["--request=DELETE", "https://a.acme.com"]), "DELETE");
	assert.equal(methodFromArgs(["-XPOST", "https://a.acme.com"]), "POST");
});

test("only GET, HEAD and OPTIONS are idempotent reads", () => {
	for (const method of ["GET", "head", "Options", " get "]) assert.equal(isIdempotentRead(method), true);
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(isIdempotentRead(method), false);
});

test("the status is read from what the tool printed, and no status is not a status", () => {
	assert.equal(statusOf("HTTP/1.1 200 OK\ncontent-type: text/html\n"), 200);
	assert.equal(statusOf("HTTP/2 403\n"), 403);
	assert.equal(statusOf("<html>hola</html>\n403"), 403);
	assert.equal(statusOf("sin estado"), null);
});

test("cacheability is narrow: reads only, never a 5xx", () => {
	const cache = createRequestCache({ dir: "/tmp/no-such-dir", program: "acme" });
	assert.equal(cache.isCacheable("GET", 200), true);
	assert.equal(cache.isCacheable("GET", 301), true);
	assert.equal(cache.isCacheable("GET", 401), true);
	assert.equal(cache.isCacheable("GET", 403), true);
	assert.equal(cache.isCacheable("GET", 500), false);
	assert.equal(cache.isCacheable("POST", 200), false);
});

async function withCache(run: (cache: ReturnType<typeof createRequestCache>, dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "bounty-cache-"));
	try {
		await run(createRequestCache({ dir, program: "acme" }), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const ENTRY = { signature: "sig", method: "GET", url: "https://a.acme.com/x", status: 200, stdout: "HTTP/1.1 200 OK\nbody", stderr: "", at: new Date().toISOString() };

test("an entry lives for the TTL and then expires", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bounty-cache-ttl-"));
	let tick = Date.parse("2026-11-18T10:00:00Z");
	try {
		const cache = createRequestCache({ dir, program: "acme", ttlMs: 1_000, clock: () => tick });
		const tracker = cache.track("sig");
		await tracker.finish({ ...ENTRY, at: new Date(tick).toISOString() });
		assert.equal((await cache.lookup("sig"))?.status, 200);

		tick += 1_500;
		assert.equal(await cache.lookup("sig"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an in-flight signature is visible and resolves for the waiters", async () => {
	await withCache(async (cache) => {
		const tracker = cache.track("sig");
		const waiter = cache.inFlight("sig");
		assert.ok(waiter);
		assert.throws(() => cache.track("sig"), /already/);
		await tracker.finish(ENTRY);
		assert.equal((await waiter)?.status, 200);
		assert.equal(cache.inFlight("sig"), undefined);
		assert.doesNotThrow(() => cache.track("sig"));
	});
});

async function sessionHarness(options: { clock?: () => number; ttlMs?: number; env?: Record<string, string> } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bounty-cache-run-"));
	await mkdir(join(dir, "work", "lab"), { recursive: true });
	const scopePath = join(dir, "scope.yaml");
	await writeFile(scopePath, "program: lab\nlab: true\nauthorized_on: 2026-01-01\nin_scope:\n  - 127.0.0.1:3000\nlimits:\n  rate_rps: 50\n", "utf8");
	const executed: string[][] = [];
	const session = createSession(
		{ root: dir, program: "lab", cache: true, ...(options.clock === undefined ? {} : { now: options.clock }) },
		{
			dns: async () => ({ cname: [] }),
			readFile: (path) => readFile(path, "utf8"),
			runTool: async (argv) => {
				executed.push([...argv]);
				return { exitCode: 0, stdout: "HTTP/1.1 200 OK\n{\"bundle\":true}", stderr: "" };
			},
			cwd: dir,
			...(options.env === undefined ? {} : { env: options.env }),
		},
	);
	await session.scope({ file: scopePath, confirm: async () => true });
	return { dir, session, executed, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("five simultaneous identical GETs make one request and spend one rate token", async () => {
	const h = await sessionHarness();
	try {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/static/main.js"], target: "http://127.0.0.1:3000/static/main.js" })),
		);
		assert.equal(h.executed.length, 1, `se ejecutó ${h.executed.length} veces`);
		assert.equal(results.filter((result) => result.text.includes("cacheHit: true")).length, 4);

		const spent = JSON.parse(await readFile(join(h.dir, "work", "lab", ".rate-limit.json"), "utf8")) as Record<string, { spent: number }>;
		const total = Object.values(spent).reduce((sum, bucket) => sum + bucket.spent, 0);
		assert.equal(total, 1, `el ritmo se gastó ${total} veces`);
	} finally {
		await h.cleanup();
	}
});

test("a different Authorization or Cookie never shares the cached answer", async () => {
	const h = await sessionHarness();
	try {
		await h.session.run({ tool: "curl", args: ["-sS", "-H", "Authorization: Bearer a", "http://127.0.0.1:3000/api/me"], target: "http://127.0.0.1:3000/api/me" });
		await h.session.run({ tool: "curl", args: ["-sS", "-H", "Authorization: Bearer b", "http://127.0.0.1:3000/api/me"], target: "http://127.0.0.1:3000/api/me" });
		await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/me"], target: "http://127.0.0.1:3000/api/me" });
		assert.equal(h.executed.length, 3);
	} finally {
		await h.cleanup();
	}
});

test("the same request twice reuses the TTL cache instead of the target", async () => {
	const h = await sessionHarness();
	try {
		const first = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		const second = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		assert.equal(first.text.includes("cacheHit: true"), false);
		assert.match(second.text, /cacheHit: true/);
		assert.equal(h.executed.length, 1);
	} finally {
		await h.cleanup();
	}
});

test("a POST is never cached", async () => {
	const h = await sessionHarness();
	try {
		await h.session.run({ tool: "curl", args: ["-sS", "-X", "POST", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		await h.session.run({ tool: "curl", args: ["-sS", "-X", "POST", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		assert.equal(h.executed.length, 2);
	} finally {
		await h.cleanup();
	}
});

test("bypassCache forces real traffic", async () => {
	const h = await sessionHarness();
	try {
		await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		const forced = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x", bypassCache: true });
		assert.equal(forced.text.includes("cacheHit: true"), false);
		assert.equal(h.executed.length, 2);
	} finally {
		await h.cleanup();
	}
});

test("S8: the verifier's environment always bypasses the cache", async () => {
	const h = await sessionHarness({ env: { GENTLE_BOUNTY_BYPASS_CACHE: "1" } });
	try {
		const first = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		const second = await h.session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:3000/api/x"], target: "http://127.0.0.1:3000/api/x" });
		assert.equal(first.text.includes("cacheHit: true"), false);
		assert.equal(second.text.includes("cacheHit: true"), false);
		assert.equal(h.executed.length, 2);
	} finally {
		await h.cleanup();
	}
});
