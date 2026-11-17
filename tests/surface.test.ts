/**
 * S1/T4: surface extraction on already-captured artifacts. No network here; the bundle arrived
 * through bounty_run and the extractor only reads it.
 *
 * The tests pin what makes it safe to feed to a swarm: paths and parameter NAMES only, static assets
 * dropped, bounded output with an honest count, and a secret that is reported by location without its
 * value ever appearing in the result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	extractFromGraphql,
	extractFromJavaScript,
	extractFromOpenApi,
	extractSurface,
	endpointBoardData,
	MAX_SURFACE_ENTRIES,
	summarizeSurface,
} from "../src/core/surface.ts";

const SECRET = "AKIAIOSFODNN7EXAMPL3";

test("javascript: routes and parameter names, static assets dropped", () => {
	const bundle = `
		fetch("/api/v1/orders?org_id=1&debug=true");
		fetch('/api/v1/orders?page=2');
		const img = "/static/logo.png";
		const css = "/assets/app.css";
		const js = "/main.abc123.js";
		const v0 = "https://a.acme.com/v0/users";
	`;
	const report = extractFromJavaScript(bundle, "files/main.js");
	assert.equal(report.kind, "javascript");
	const paths = report.endpoints.map((endpoint) => endpoint.path).sort();
	assert.deepEqual(paths, ["/api/v1/orders", "/v0/users"]);
	const orders = report.endpoints.find((endpoint) => endpoint.path === "/api/v1/orders");
	assert.deepEqual([...(orders?.params ?? [])].sort(), ["debug", "org_id", "page"]);
	assert.equal(report.dropped, 0);
});

test("javascript: a template literal becomes a parameter, not a broken path", () => {
	const report = extractFromJavaScript('fetch(`/api/v1/users/${userId}/invoices`)', "files/main.js");
	assert.deepEqual(report.endpoints.map((endpoint) => endpoint.path), ["/api/v1/users/:param/invoices"]);
});

test("javascript: a secret is reported by location and never by value", () => {
	const report = extractFromJavaScript(`const config = { apiKey: "${SECRET}" };`, "files/main.js");
	assert.equal(report.secrets.length, 1);
	assert.match(report.secrets[0]?.location ?? "", /files\/main\.js@/);
	assert.match(report.secrets[0]?.pattern ?? "", /apiKey/);
	assert.ok(!JSON.stringify(report).includes(SECRET), "the secret value leaked into the report");
});

test("the output is bounded and says how much it dropped", () => {
	const bundle = Array.from({ length: MAX_SURFACE_ENTRIES + 25 }, (_unused, index) => `"/api/v1/item/${index}"`).join("\n");
	const report = extractFromJavaScript(bundle, "files/main.js");
	assert.equal(report.endpoints.length, MAX_SURFACE_ENTRIES);
	assert.equal(report.dropped, 25);
	assert.match(summarizeSurface(report), /25 entrada\(s\) descartadas/);
});

test("openapi: methods and parameters from the schema, not from guesses", () => {
	const doc = JSON.stringify({
		openapi: "3.0.0",
		paths: {
			"/api/v1/invoices/{id}": {
				parameters: [{ name: "id", in: "path" }],
				get: { parameters: [{ name: "expand", in: "query" }] },
				delete: {},
				description: "no es un método",
			},
		},
	});
	const report = extractFromOpenApi(doc, "files/openapi.json");
	assert.ok(report);
	assert.equal(report?.kind, "openapi");
	assert.deepEqual(report?.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(), ["DELETE /api/v1/invoices/{id}", "GET /api/v1/invoices/{id}"]);
	const get = report?.endpoints.find((endpoint) => endpoint.method === "GET");
	assert.deepEqual([...(get?.params ?? [])].sort(), ["expand", "id"]);
});

test("swagger 2.0 is recognized too", () => {
	const doc = JSON.stringify({ swagger: "2.0", paths: { "/api/v1/users": { get: {} } } });
	const report = extractFromOpenApi(doc, "files/swagger.json");
	assert.equal(report?.kind, "openapi");
	assert.equal(report?.endpoints.length, 1);
});

test("graphql: queries and mutations with their arguments", () => {
	const doc = JSON.stringify({
		data: {
			__schema: {
				types: [
					{ name: "Query", fields: [{ name: "user", args: [{ name: "id" }] }] },
					{ name: "Mutation", fields: [{ name: "deleteInvoice", args: [{ name: "id" }, { name: "hard" }] }] },
					{ name: "User", fields: [{ name: "email" }] },
				],
			},
		},
	});
	const report = extractFromGraphql(doc, "files/schema.json");
	assert.equal(report?.kind, "graphql");
	assert.deepEqual(report?.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`), ["QUERY Query.user", "MUTATION Mutation.deleteInvoice"]);
	const mutation = report?.endpoints.find((endpoint) => endpoint.method === "MUTATION");
	assert.deepEqual(mutation?.params, ["id", "hard"]);
});

test("detection falls back to javascript, and unknown json is not a schema", () => {
	const graphql = extractSurface(JSON.stringify({ data: { __schema: { types: [] } } }), "f.json");
	assert.equal(graphql.kind, "graphql");
	const openapi = extractSurface(JSON.stringify({ openapi: "3.1.0", paths: {} }), "f.json");
	assert.equal(openapi.kind, "openapi");
	const other = extractSurface(JSON.stringify({ hello: "/api/v1/x" }), "f.json");
	assert.equal(other.kind, "javascript");
	assert.deepEqual(other.endpoints.map((endpoint) => endpoint.path), ["/api/v1/x"]);
});

test("the board payload carries shape only", () => {
	const [endpoint] = extractFromJavaScript('fetch("/api/v1/orders?org_id=1")', "files/main.js").endpoints;
	assert.ok(endpoint);
	const data = endpointBoardData(endpoint);
	assert.deepEqual(data, { path: "/api/v1/orders", params: ["org_id"], source: "files/main.js" });
});

test("a minified single line still yields its routes", () => {
	const minified = `!function(){fetch("/api/v1/auth/login",{method:"POST"}),fetch("/graphql",{method:"POST"})}();`;
	const report = extractFromJavaScript(minified, "files/app.min.js");
	assert.deepEqual(report.endpoints.map((endpoint) => endpoint.path).sort(), ["/api/v1/auth/login", "/graphql"]);
});

test("the summary counts by method and by plain route", () => {
	const report = extractFromOpenApi(JSON.stringify({ openapi: "3.0.0", paths: { "/a": { get: {}, post: {} }, "/b": { get: {} } } }), "f.json");
	assert.ok(report);
	const summary = summarizeSurface(report);
	assert.match(summary, /3 endpoint\(s\)/);
	assert.match(summary, /2 GET/);
	assert.match(summary, /1 POST/);
});
