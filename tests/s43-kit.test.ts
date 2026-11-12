/**
 * S65: the S43 kit must produce a scope and a command that the REAL gate lets through to the
 * destructive pause. If the gate blocked them, the test would prove nothing about the confirmation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceStore } from "../src/core/evidence.ts";
import { createSession } from "../src/pi/session.ts";
import { gate } from "../src/core/gate.ts";
import { parseScope } from "../src/core/scope.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function prepare() {
	const root = await mkdtemp(join(tmpdir(), "bounty-s43-kit-"));
	const binDir = join(root, "bin");
	const marker = join(root, "marker.txt");
	await mkdir(join(root, ".lab"), { recursive: true });
	await writeFile(join(root, ".lab", "port"), "33971\n", "utf8");
	const output = execFileSync("sh", [join(REPO, "scripts/s43-prepare.sh")], {
		encoding: "utf8",
		env: { ...process.env, GENTLE_BOUNTY_ROOT: root, GENTLE_BOUNTY_S43_BIN: binDir, GENTLE_BOUNTY_S43_MARKER: marker },
	});
	return { root, binDir, marker, output };
}

test("the kit writes a lab scope that does not forbid brute-force", async () => {
	const kit = await prepare();
	try {
		const scope = parseScope(await readFile(join(kit.root, "work", "lab-s43", "scope.yaml"), "utf8"));
		assert.equal(scope.ok, true, JSON.stringify(scope));
		if (!scope.ok) return;
		assert.equal(scope.policy.lab, true);
		assert.equal(scope.policy.limits.rateRps, 5);
		assert.ok(scope.policy.limits.forbidden.includes("dos"));
		assert.ok(!scope.policy.limits.forbidden.includes("brute-force"), "the test scope must not forbid the class under test");
		assert.deepEqual(
			scope.policy.inScope.map((rule) => rule.raw),
			["127.0.0.1:33971"],
		);
	} finally {
		await rm(kit.root, { recursive: true, force: true });
	}
});

test("the hydra command of the kit reaches the destructive pause through the real gate", async () => {
	const kit = await prepare();
	try {
		const parsed = parseScope(await readFile(join(kit.root, "work", "lab-s43", "scope.yaml"), "utf8"));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const args = ["-L", "logins.txt", "-P", "passwords.txt", "127.0.0.1:33971", "ssh"];
		const decision = await gate(
			parsed.policy,
			{ target: "http://127.0.0.1:33971/login", argv: args, headers: {} } as never,
			{ dns: async () => ({ cname: [] }), readFile: async () => "" },
		);
		assert.equal(decision.allowed, true, JSON.stringify(decision));
	} finally {
		await rm(kit.root, { recursive: true, force: true });
	}
});

test("the out-of-scope command of the kit is denied by the real gate, with a readable reason", async () => {
	const kit = await prepare();
	try {
		const parsed = parseScope(await readFile(join(kit.root, "work", "lab-s43", "scope.yaml"), "utf8"));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const decision = await gate(
			parsed.policy,
			{ target: "http://127.0.0.1:33972/", argv: ["-sS", "http://127.0.0.1:33972/"], headers: {} } as never,
			{ dns: async () => ({ cname: [] }), readFile: async () => "" },
		);
		assert.equal(decision.allowed, false);
		if (!decision.allowed) assert.match(decision.reason, /no in_scope rule matched 127\.0\.0\.1:33972/);
	} finally {
		await rm(kit.root, { recursive: true, force: true });
	}
});

test("the kit prints the MOSH launch command, writes tool_path, and the marker is harmless", async () => {
	const kit = await prepare();
	try {
		assert.match(kit.output, /MOSH_CONNECTION=orca/);
		assert.match(kit.output, /bin\/gentle-bounty lab-s43/);
		// B1: the child PATH comes from the operator's config now, not from the shell.
		const config = JSON.parse(await readFile(join(kit.root, ".bounty", "config.json"), "utf8"));
		assert.ok((config.tool_path ?? []).includes(kit.binDir), JSON.stringify(config));
		// The "hydra" only writes the marker.
		execFileSync("sh", [join(kit.binDir, "hydra"), "-L", "x"], { encoding: "utf8" });
		assert.match(await readFile(kit.marker, "utf8"), /called with: -L x/);
	} finally {
		await rm(kit.root, { recursive: true, force: true });
	}
});

test("7d: the out-of-scope run of the kit leaves no execution record and one gate record", async () => {
	const kit = await prepare();
	try {
		const scopePath = join(kit.root, "work", "lab-s43", "scope.yaml");
		const session = createSession(
			{ root: kit.root, program: "lab-s43" },
			{
				dns: async () => ({ cname: [] }),
				readFile: (path) => readFile(path, "utf8"),
				runTool: async () => ({ exitCode: 0, stdout: "no debería ejecutarse", stderr: "" }),
				confirm: async () => true,
			},
		);
		await session.scope({ file: scopePath });
		await session.run({ tool: "curl", args: ["-sS", "http://127.0.0.1:33972/"], target: "http://127.0.0.1:33972/" });

		const records = await createEvidenceStore(join(kit.root, "work", "lab-s43", "evidence"), { now: () => Date.now() }).read();
		assert.equal(records.filter((record) => record.kind === "execution").length, 0, "a blocked run wrote an execution record");
		const gate = records.filter((record) => record.kind === "gate");
		assert.equal(gate.length, 1);
		assert.match((gate[0]?.payload as { reason: string }).reason, /no in_scope rule matched 127\.0\.0\.1:33972/);
	} finally {
		await rm(kit.root, { recursive: true, force: true });
	}
});
