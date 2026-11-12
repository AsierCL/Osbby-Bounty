/**
 * S35: destructive classification is inferred, not declared, and ambiguity resolves toward pausing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyDestructive } from "../src/core/destructive.ts";

function classify(tool: string, args: string[], extra: Partial<Parameters<typeof classifyDestructive>[0]> = {}) {
	return classifyDestructive({ tool, args, scopeRateRps: 50, ...extra });
}

test("ffuf above the program rate is destructive", () => {
	const verdict = classify("ffuf", ["-w", "words.txt", "-u", "https://a.acme.com/FUZZ", "-rate", "200"]);
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /exceeds the program rate/);
});

test("normal discovery inside the program rate is not destructive", () => {
	const verdict = classify("ffuf", ["-w", "words.txt", "-u", "https://a.acme.com/FUZZ", "-rate", "5"]);
	assert.equal(verdict.destructive, false, JSON.stringify(verdict));
});

test("hydra and medusa are destructive whatever the arguments say", () => {
	for (const binary of ["hydra", "/usr/bin/hydra", "medusa", "/opt/medusa"]) {
		const verdict = classify(binary, ["-l", "admin", "-P", "words.txt", "a.acme.com", "ssh"]);
		assert.equal(verdict.destructive, true, binary);
		assert.match(verdict.reason ?? "", /brute-force/);
	}
});

test("a password wordlist against a login endpoint is destructive", () => {
	const verdict = classify("ffuf", ["-w", "rockyou.txt", "-u", "https://a.acme.com/login"]);
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /password wordlist/);
});

test("a normal wordlist against a normal path stays non-destructive", () => {
	const verdict = classify("ffuf", ["-w", "common.txt", "-u", "https://a.acme.com/static", "-rate", "5"]);
	assert.equal(verdict.destructive, false, JSON.stringify(verdict));
});

test("flooding flags are destructive", () => {
	assert.equal(classify("hping3", ["--flood", "a.acme.com"]).destructive, true);
	assert.equal(classify("nuclei", ["-u", "https://a.acme.com", "--rate-limit", "0"]).destructive, true);
});

test("intrusive nuclei tags are destructive", () => {
	const verdict = classify("nuclei", ["-u", "https://a.acme.com", "-tags", "cve,dos"]);
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /intrusive/);
});

test("high concurrency plus a login target resolves toward pausing", () => {
	const verdict = classify("ffuf", ["-c", "50", "-w", "common.txt", "-u", "https://a.acme.com/login"]);
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /ambiguous combination/);
});

test("a declared destructive class adds a reason and never removes one", () => {
	const declared = classify("httpx", ["-u", "https://a.acme.com"], { technique: "dos" });
	assert.equal(declared.destructive, true);
	assert.match(declared.reason ?? "", /declared class/);

	const declaredSafe = classify("httpx", ["-u", "https://a.acme.com"], { technique: "idor" });
	assert.equal(declaredSafe.destructive, false);

	const declaredSafeButToolIsBruteForce = classify("hydra", ["a.acme.com", "ssh"], { technique: "idor" });
	assert.equal(declaredSafeButToolIsBruteForce.destructive, true, "a safe declaration must not cancel a real signal");
});

test("a program forbidden list adds a strong signal", () => {
	const verdict = classify("ffuf", ["-u", "https://a.acme.com"], { technique: "brute-force", forbidden: ["brute-force"] });
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /forbidden list/);
});

test("an explicit rate with no declared program rate is ambiguous, so it pauses", () => {
	const verdict = classifyDestructive({ tool: "ffuf", args: ["-w", "words.txt", "-u", "https://a.acme.com", "-rate", "20"], scopeRateRps: null });
	assert.equal(verdict.destructive, true);
	assert.match(verdict.reason ?? "", /no rate declared/);
});
