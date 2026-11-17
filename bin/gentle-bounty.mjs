#!/usr/bin/env node
/**
 * Main-session launcher (S34).
 *
 * The child runner is not the only thing that needs a tool allowlist: the session that *loads* this
 * extension is the one with the most opportunity to misbehave. This launcher starts it with the same
 * restrictions the children get: no MCP unless the operator opts in, no other extensions, and an
 * explicit tool allowlist with no shell, no generic fetch and no write.
 *
 *   bin/gentle-bounty <program> [--check] [--probe <file>] [-- <extra pi args>]
 *
 * `--check` prints the exact argv and cwd without launching anything: that is the deterministic
 * inspection path. The live tool list is checked by scripts/tools-probe.ts during a real run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAIN_SESSION_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bounty_scope",
	"bounty_run",
	"bounty_evidence",
	"bounty_board",
	"bounty_session",
	"bounty_finding",
	"bounty_phase",
	"bounty_status",
	"bounty_stop",
];

const FORBIDDEN = /bash|shell|exec|terminal|fetch|http|web|write|edit|\*/i;

export function buildLaunch({ program, root, probeFile, approvedMcp, extra = [] }) {
	if (!program || program.includes("/") || program.includes("..")) {
		throw new Error("a program name is required and must not contain a path separator");
	}
	for (const tool of MAIN_SESSION_TOOLS) {
		if (FORBIDDEN.test(tool)) throw new Error(`refusing to launch: allowlist contains ${tool}`);
	}
	const workDir = join(process.cwd(), "work", program);
	const args = [];
	if (!approvedMcp || approvedMcp.length === 0) {
		// MCP stays the operator's decision: without an explicit opt-in, no MCP server is reachable.
		args.push("--no-mcp");
	}
	// S75/task 5: the bounty session does not need the host's skill catalog. With skills off, the
	// session starts with its own instructions and nothing else from the global registry.
	args.push("-ne", "-ns", "-e", join(root, "extensions", "bounty.ts"));
	if (probeFile) {
		const probeTarget = join(workDir, "probe-tools.json");
		if (resolve(probeFile) === probeTarget) throw new Error("the probe output path must not be the probe extension itself");
		args.push("-e", resolve(probeFile));
	}
	args.push("--tools", MAIN_SESSION_TOOLS.join(","), ...extra);
	return {
		command: "pi",
		args,
		cwd: workDir,
		env: {
			GENTLE_BOUNTY_ROOT: process.cwd(),
			GENTLE_BOUNTY_PROGRAM: program,
			...(probeFile ? { GENTLE_BOUNTY_PROBE_FILE: join(workDir, "probe-tools.json") } : {}),
		},
	};
}

async function preflight(program, root) {
	const { parseScope } = await import("../src/core/scope.ts");
	const { preflightScope } = await import("../src/core/preflight.ts");
	const { loadGlobalConfig } = await import("../src/core/config.ts");
	const { execFileSync } = await import("node:child_process");
	const { existsSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");

	const lines = [];
	const failures = [];
	const warnings = [];
	const ok = (message) => lines.push(`OK    ${message}`);
	const warn = (message) => {
		warnings.push(message);
		lines.push(`AVISO ${message}`);
	};
	const fail = (message) => {
		failures.push(message);
		lines.push(`FALLA ${message}`);
	};

	// 1. test affordances must be off
	for (const name of ["GENTLE_BOUNTY_ALLOW_CONFIRM_STUB", "GENTLE_BOUNTY_CONFIRM_TEST", "GENTLE_BOUNTY_PRELOAD_SCOPE", "GENTLE_BOUNTY_VERIFIER"]) {
		if (process.env[name] !== undefined && process.env[name] !== "") fail(`la variable ${name} está definida: las atafetas de test no van en una sesión real`);
	}
	if (failures.length === 0) ok("variables de test sin definir");

	// 2. scope parses, with an explicit lab flag
	const scopePath = join(root, "work", program, "scope.yaml");
	let policy = null;
	if (!existsSync(scopePath)) {
		fail(`no encuentro el scope en ${scopePath}`);
	} else {
		const parsed = parseScope(readFileSync(scopePath, "utf8"));
		if (!parsed.ok) {
			fail(`el scope no parsea: ${parsed.errors[0] ?? "error desconocido"}`);
			for (const error of parsed.errors.slice(1)) lines.push(`      ${error}`);
			for (const error of parsed.errors) {
				if (/is empty/i.test(error)) lines.push(`      pista: la clave está vacía porque no tiene ninguna entrada; borrala o agregá al menos un host.`);
				else if (/bare wildcard/i.test(error)) lines.push(`      pista: "*/" no es un host; in_scope ya limita, así que no hace falta excluir "todo lo demás".`);
			}
		} else {
			policy = parsed.policy;
			ok(`el scope parsea y declara lab: ${parsed.policy.lab}`);
			for (const warning of parsed.warnings) warn(`el scope avisa: ${warning}`);
			// S75/task 4: the same interpreted summary bounty_scope prints, plus its warnings.
			const interpreted = preflightScope(readFileSync(scopePath, "utf8"));
			lines.push("", "--- resumen interpretado ---", interpreted.text, "");
		}
	}

	// 3. rate declared
	if (policy !== null) {
		if (policy.limits.rateRps === null) warn("el scope no declara limits.rate_rps: el gate va a 1 req/s por defecto");
		else if (policy.limits.rateRps > 10) warn(`el ritmo declarado (${policy.limits.rateRps} req/s) está por encima de lo prudente (10 req/s)`);
		else ok(`ritmo declarado: ${policy.limits.rateRps} req/s`);
	}

	// 4. binaries: curl is required for the lab flow, the rest are optional
	const has = (binary) => {
		try {
			execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	if (!has("curl")) fail("falta curl: es la herramienta con la que el lab se recorre hoy");
	else ok("curl instalado");
	const optional = ["jq", "nuclei", "httpx", "ffuf", "subfinder"];
	const missing = optional.filter((binary) => !has(binary));
	if (missing.length === 0) ok("binarios opcionales presentes");
	else warn(`faltan binarios opcionales (no los instalo): ${missing.join(", ")}. Ojo: el httpx del PATH puede ser el cliente de Python, no el de Project Discovery`);

	// 4b. S69: a lab scope should point at a port where the lab is actually listening.
	if (policy !== null && policy.lab === true) {
		const { connect } = await import("node:net");
		const probe = (host, port) =>
			new Promise((resolve) => {
				const socket = connect({ host, port });
				const done = (result) => {
					socket.destroy();
					resolve(result);
				};
				socket.setTimeout(300);
				socket.once("connect", () => done(true));
				socket.once("timeout", () => done(false));
				socket.once("error", () => done(false));
			});
		for (const rule of policy.inScope) {
			const port = rule.port === null ? 80 : rule.port;
			const host = rule.host;
			if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
				warn(`la regla ${rule.raw} no es localhost: el preflight no la sondea (solo localhost)`);
				continue;
			}
			const listening = await probe(host, port);
			if (!listening) warn(`en ${host}:${port} no escucha nada: ¿levantaste el lab? (./scripts/lab-up.sh)`);
			else ok(`el lab escucha en ${host}:${port}`);
		}
	}

	// 5. budget
	try {
		const config = await loadGlobalConfig(async (path) => readFileSync(path, "utf8"), join(root, ".bounty", "config.json"));
		const budget = config.budget ?? {};
		if (Object.keys(budget).length === 0) {
			const { DEFAULT_BUDGET } = await import("../src/pi/budget.ts");
			warn(
				`no hay presupuesto configurado en .bounty/config.json: se usan los defaults (${DEFAULT_BUDGET.maxWallMs / 3_600_000} h, ${DEFAULT_BUDGET.maxToolCalls} llamadas, ${DEFAULT_BUDGET.maxTokens / 1_000_000}M tokens)`,
			);
		} else {
			ok(`presupuesto configurado: ${JSON.stringify(budget)}`);
		}
	} catch (error) {
		fail(`la configuración no es válida: ${error.message}`);
	}

	// 6. git tree
	try {
		const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim();
		if (status === "") ok("árbol git limpio");
		else if (policy !== null && policy.lab === true) warn("el árbol git tiene cambios (en un lab no importa)");
		else fail("el árbol git tiene cambios sin commitear: antes de un programa real, dejalo limpio");
	} catch {
		warn("no pude leer el estado de git (¿este directorio no es un repo?)");
	}

	lines.push("");
	if (failures.length === 0) {
		lines.push(`VEREDICTO: OK — podés arrancar ${program}${warnings.length > 0 ? ` (con ${warnings.length} aviso(s) arriba)` : ""}`);
	} else {
		lines.push(`VEREDICTO: NO — ${failures.length} cosa(s) para corregir antes de arrancar`);
	}
	for (const line of lines) console.log(line);
	return failures.length === 0 ? 0 : 1;
}

function packageRootOf() {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function printMorning(report) {
	console.log(report.text);
	return true;
}

async function main(argv) {
	const check = argv.includes("--check");
	const probeIndex = argv.indexOf("--probe");
	const probeFile = probeIndex >= 0 ? argv[probeIndex + 1] : undefined;
	const passthroughIndex = argv.indexOf("--");
	const passthrough = passthroughIndex >= 0 ? argv.slice(passthroughIndex + 1) : [];
	const positional = argv.filter((arg, index) => {
		if (arg.startsWith("--")) return false;
		if (probeIndex >= 0 && index === probeIndex + 1) return false;
		if (passthroughIndex >= 0 && index > passthroughIndex) return false;
		return true;
	});
	// S89/S90: read-only summaries.
	if (argv.includes("--morning")) {
		const { morningReport } = await import("../scripts/lib/morning.ts");
		process.exit(typeof morningReport === "function" ? (printMorning(await morningReport(process.env.GENTLE_BOUNTY_ROOT ?? process.cwd())) ? 0 : 0) : 0);
	}
	// S102: the operator restarts the clock and the counters; the limits stay in .bounty/config.json.
	const restartIndex = argv.indexOf("--restart-limits");
	if (restartIndex >= 0) {
		const target = argv[restartIndex + 1];
		if (!target || target.startsWith("--")) {
			console.error("usage: gentle-bounty --restart-limits <programa>|--all");
			process.exit(2);
		}
		const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
		const child = spawnSync(process.execPath, ["--experimental-strip-types", join(packageRootOf(), "scripts", "restart-limits.ts"), root, target], { stdio: "inherit" });
		process.exit(child.status ?? 1);
	}

	// S103: raise the policy and restart the counters in one operator action.
	const extendIndex = argv.indexOf("--extend-budget");
	if (extendIndex >= 0) {
		const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
		const child = spawnSync(process.execPath, ["--experimental-strip-types", join(packageRootOf(), "scripts", "extend-budget.ts"), root, ...argv.slice(extendIndex + 1)], { stdio: "inherit" });
		process.exit(child.status ?? 1);
	}

	// S105: the same human confirmation, from the operator's own terminal.
	const confirmIndex = argv.indexOf("--confirm-scope");
	if (confirmIndex >= 0) {
		const target = argv[confirmIndex + 1];
		if (!target || target.startsWith("--")) {
			console.error("usage: gentle-bounty --confirm-scope <programa>");
			process.exit(2);
		}
		const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
		const child = spawnSync(process.execPath, ["--experimental-strip-types", join(packageRootOf(), "scripts", "confirm-scope.ts"), root, target], { stdio: "inherit" });
		process.exit(child.status ?? 1);
	}

	const pendingIndex = argv.indexOf("--pending");
	if (pendingIndex >= 0) {
		const target = argv[pendingIndex + 1];
		if (!target || target.startsWith("--")) {
			console.error("usage: gentle-bounty --pending <programa>");
			process.exit(2);
		}
		const root = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
		// The human's TTY is the confirmation surface; an agent has no path to it.
		const child = spawnSync(process.execPath, ["--experimental-strip-types", join(packageRootOf(), "scripts", "pending-cli.ts"), root, target], { stdio: "inherit" });
		process.exit(child.status ?? 1);
	}

	const program = positional[0];
	if (!program) {
		console.error("usage: gentle-bounty <program> [--check] [--probe <file>] [-- <pi args>]");
		console.error("        gentle-bounty --morning | --preflight <programa> | --pending <programa>");
		process.exit(2);
	}
	const preflightIndex = argv.indexOf("--preflight");
	if (preflightIndex >= 0) {
		const target = argv[preflightIndex + 1];
		if (!target || target.startsWith("--")) {
			console.error("usage: gentle-bounty --preflight <programa>");
			process.exit(2);
		}
		const scopeRoot = process.env.GENTLE_BOUNTY_ROOT ?? process.cwd();
		process.exit(await preflight(target, scopeRoot));
	}

	const approvedMcp = (process.env.GENTLE_BOUNTY_MCP ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let launch;
	try {
		launch = buildLaunch({ program, root: packageRoot, probeFile, approvedMcp, extra: passthrough });
	} catch (error) {
		console.error(`gentle-bounty: ${error.message}`);
		process.exit(2);
	}

	mkdirSync(launch.cwd, { recursive: true });

	if (check) {
		console.log(JSON.stringify({ command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, tools: MAIN_SESSION_TOOLS }, null, 2));
		return;
	}

	// B5: the verifier role no longer exists as an environment variable; never inherit one.
	delete process.env.GENTLE_BOUNTY_VERIFIER;
	const result = spawnSync(launch.command, launch.args, {
		cwd: launch.cwd,
		stdio: "inherit",
		env: { ...process.env, ...launch.env },
	});
	if (result.error) {
		console.error(`gentle-bounty: could not start pi: ${result.error.message}`);
		process.exit(127);
	}
	process.exit(result.status ?? 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
