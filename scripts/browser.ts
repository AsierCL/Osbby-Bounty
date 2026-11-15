/**
 * S88: a gate-compatible browser.
 *
 * Why it exists: the live agent could not verify a DataDome-protected login with curl (TLS fingerprint),
 * and a raw browser would fetch hosts the gate never validated. This wrapper:
 *   - takes the URL from argv, so the gate validates it and it lands in the evidence chain;
 *   - checks EVERY request the page makes against the same scope matcher (scripts/lib/nav-policy.ts)
 *     and aborts anything outside it, including third-party assets;
 *   - takes headers from `-H "Name: value"` in argv, so a required User-Agent is real;
 *   - never reads credentials from argv: use a Playwright storage-state file (cookies) via
 *     GENTLE_BOUNTY_STORAGE_STATE, and the password stays wherever you typed it;
 *   - writes a screenshot and/or the HTML to files, and prints one JSON line.
 *
 * Usage (through bounty_run, the only way the agent should reach it):
 *   bounty_run tool="node" args=["scripts/browser.ts","https://www.thefork.com/login",
 *     "-H","User-Agent: bugcrowd-research","--out","/tmp/login.png","--html","/tmp/login.html"]
 *
 * Env the operator sets: GENTLE_BOUNTY_SCOPE (path to the confirmed scope), GENTLE_BOUNTY_PLAYWRIGHT
 * (path to a playwright module directory when it is not resolvable), GENTLE_BOUNTY_STORAGE_STATE.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { makeNavPolicy } from "./lib/nav-policy.ts";

const argv = process.argv.slice(2);
const url = argv.find((token) => /^https?:\/\//i.test(token));
if (url === undefined) {
	console.error("usage: browser.ts <url> [-H 'Name: value']... [--out <png>] [--html <file>] [--wait <ms>]");
	process.exit(2);
}

function flag(name: string): string | null {
	const index = argv.indexOf(name);
	return index >= 0 && argv[index + 1] !== undefined ? (argv[index + 1] as string) : null;
}

const headers: Record<string, string> = {};
for (let index = 0; index < argv.length; index += 1) {
	const token = argv[index] as string;
	if (token !== "-H" && token !== "--header") continue;
	const raw = argv[index + 1] ?? "";
	const separator = raw.indexOf(":");
	if (separator > 0) headers[raw.slice(0, separator).trim().toLowerCase()] = raw.slice(separator + 1).trim();
}

const scopePath = process.env.GENTLE_BOUNTY_SCOPE;
if (scopePath === undefined || scopePath.length === 0) {
	console.error("GENTLE_BOUNTY_SCOPE is not set: the browser refuses to run without a scope to check against");
	process.exit(2);
}
const nav = makeNavPolicy(await readFile(scopePath, "utf8"));

function loadPlaywright(): { chromium: { launch(options?: Record<string, unknown>): Promise<unknown> } } {
	const candidates = [
		process.env.GENTLE_BOUNTY_PLAYWRIGHT,
		join(process.env.HOME ?? "", ".npm/_npx/705bc6b22212b352/node_modules/playwright"),
	].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
	const local = createRequire(import.meta.url);
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			return local(candidate) as never;
		} catch (error) {
			errors.push(`${candidate}: ${(error as Error).message.slice(0, 80)}`);
		}
	}
	try {
		return local("playwright") as never;
	} catch (error) {
		errors.push(`playwright: ${(error as Error).message.slice(0, 80)}`);
	}
	throw new Error(`playwright is not resolvable (${errors.join(" | ")})`);
}

const playwright = loadPlaywright();
const browser = (await (playwright.chromium.launch({ headless: true }) as Promise<{ newContext(options?: Record<string, unknown>): Promise<{ newPage(): Promise<unknown>; storageState?(): Promise<unknown> }>; close(): Promise<void> }>));
const storage = process.env.GENTLE_BOUNTY_STORAGE_STATE;
const context = await browser.newContext({
	...(Object.keys(headers).length > 0 ? { extraHTTPHeaders: headers } : {}),
	...(storage === undefined || storage.length === 0 ? {} : { storageState: storage }),
});

const blocked: string[] = [];
await (context as unknown as { route(pattern: string, handler: (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => Promise<void>): Promise<void> }).route("**/*", async (route) => {
	const requestUrl = route.request().url();
	const decision = nav.decide(requestUrl);
	if (decision.allowed) return route.continue();
	blocked.push(requestUrl);
	return route.abort();
});

const page = (await context.newPage()) as {
	goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>;
	title(): Promise<string>;
	content(): Promise<string>;
	waitForTimeout(ms: number): Promise<void>;
	screenshot(options: Record<string, unknown>): Promise<unknown>;
};
let status: number | null = null;
let error: string | null = null;
try {
	const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
	status = response?.status() ?? null;
	const wait = Number(flag("--wait") ?? "1500");
	if (Number.isFinite(wait) && wait > 0) await page.waitForTimeout(wait);
	const out = flag("--out");
	if (out !== null) await writeFile(out, (await page.screenshot({ fullPage: true })) as never);
	const html = flag("--html");
	if (html !== null) await writeFile(html, await page.content(), "utf8");
	console.log(
		JSON.stringify({
			url,
			status,
			title: await page.title(),
			blockedRequests: blocked.slice(0, 20),
			blockedCount: blocked.length,
			out,
			html,
		}),
	);
} catch (caught) {
	error = (caught as Error).message.slice(0, 200);
	console.log(JSON.stringify({ url, status, error, blockedRequests: blocked.slice(0, 20), blockedCount: blocked.length }));
} finally {
	await browser.close();
}
process.exit(error === null ? 0 : 3);
