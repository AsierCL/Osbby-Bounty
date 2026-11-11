/**
 * Redaction of what reaches the model (S11 C4): `bounty_run` returns a redacted view, the raw stays
 * in the evidence store. The test that matters most is the one that greps the produced view for the
 * secret: a redaction list is worthless if the value is still there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redactHeaders, redactRequest, redactResponse, redactUrl } from "../src/core/redact.ts";

const SECRETS = {
	cookie: "session=abcdef123456",
	authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
	apiKey: "sk_live_9f8e7d6c5b4a",
	queryToken: "tok_live_42",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJl",
	email: "victim.person@example.com",
	password: "hunter2-not-a-real-password",
};

test("credential headers are replaced, not dropped silently", () => {
	const { headers, redactions } = redactHeaders({
		cookie: SECRETS.cookie,
		Authorization: SECRETS.authorization,
		"X-Api-Key": SECRETS.apiKey,
		"Set-Cookie": SECRETS.cookie,
		"Content-Type": "application/json",
	});
	assert.equal(headers.cookie, "[REDACTED]");
	assert.equal(headers.Authorization, "[REDACTED]");
	assert.equal(headers["X-Api-Key"], "[REDACTED]");
	assert.equal(headers["Set-Cookie"], "[REDACTED]");
	assert.equal(headers["Content-Type"], "application/json");
	assert.ok(redactions.includes("header:authorization"));
});

test("header names are matched case-insensitively", () => {
	const { headers } = redactHeaders({ AUTHoRiZATION: "Bearer abc" });
	const values = Object.values(headers);
	assert.deepEqual(values, ["[REDACTED]"]);
});

test("sensitive query parameters are redacted and the rest survives", () => {
	const { url, redactions } = redactUrl(`http://localhost:3000/cb?token=${SECRETS.queryToken}&page=2&api_key=${SECRETS.apiKey}`);
	assert.ok(!url.includes(SECRETS.queryToken));
	assert.ok(!url.includes(SECRETS.apiKey));
	assert.ok(url.includes("page=2"));
	assert.ok(redactions.some((entry) => entry.startsWith("query:token")));
});

test("a non-http url is returned unchanged", () => {
	const { url } = redactUrl("not a url");
	assert.equal(url, "not a url");
});

test("tokens, JWTs, passwords and emails in a body are redacted", () => {
	const body = JSON.stringify({
		note: `call with ${SECRETS.authorization}`,
		id_token: SECRETS.jwt,
		password: SECRETS.password,
		owner: SECRETS.email,
	});
	const view = redactResponse({ status: 200, headers: {}, body });
	const serialized = JSON.stringify(view);
	for (const secret of [SECRETS.jwt, SECRETS.password, SECRETS.email, "eyJhbGciOiJIUzI1NiJ9"]) {
		assert.ok(!serialized.includes(secret), `leaked ${secret}`);
	}
	assert.equal(view.status, 200);
	assert.ok(view.redactions.length >= 3);
});

test("a body over the limit is truncated with a marker and a byte count", () => {
	const view = redactResponse({ status: 200, headers: {}, body: "a".repeat(5000) }, { maxBodyBytes: 100 });
	assert.ok(view.body !== null && view.body.length < 5000);
	assert.match(view.body, /truncated 4900 bytes/);
	assert.equal(view.truncatedBytes, 4900);
});

test("a missing body stays null", () => {
	const view = redactResponse({ status: 204, headers: {} });
	assert.equal(view.body, null);
	assert.deepEqual(view.redactions, []);
});

test("the request view keeps method and url but loses credentials", () => {
	const view = redactRequest({
		method: "POST",
		url: `http://localhost:3000/api/x?access_token=${SECRETS.queryToken}`,
		headers: { Authorization: SECRETS.authorization, "Content-Type": "application/json" },
		body: `{"password":"${SECRETS.password}"}`,
	});
	assert.equal(view.method, "POST");
	assert.ok(!JSON.stringify(view).includes(SECRETS.queryToken));
	assert.ok(!JSON.stringify(view).includes(SECRETS.authorization));
	assert.ok(!JSON.stringify(view).includes(SECRETS.password));
});

test("redaction labels never contain the redacted value", () => {
	const view = redactRequest({ method: "GET", url: "http://x/y", headers: { Cookie: SECRETS.cookie }, body: SECRETS.jwt });
	for (const label of view.redactions) {
		assert.ok(!label.includes(SECRETS.cookie));
		assert.ok(!label.includes(SECRETS.jwt));
	}
});

test("long opaque values are redacted even without a recognizable prefix", () => {
	const opaque = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
	const view = redactResponse({ status: 200, headers: {}, body: `key=${opaque}` });
	assert.ok(!JSON.stringify(view).includes(opaque));
});
