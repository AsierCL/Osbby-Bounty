/**
 * S68: the composed prompt contains the identity, the protocol and the five non-negotiable rules.
 * Deterministic: no session, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildDomainPrompt, DOMAIN_RULES, renderDomainPrompt } from "../src/pi/prompt.ts";

const ASSETS = new URL("../assets/", import.meta.url).pathname;

test("the prompt carries the identity and the protocol from the assets", async () => {
	const prompt = await buildDomainPrompt((path) => readFile(path, "utf8"), ASSETS);
	assert.match(prompt, /## Dominio: bug bounty/);
	assert.match(prompt, /Bounty Hunter/);
	assert.match(prompt, /## Protocolo/);
	assert.match(prompt, /Las siete fases/);
});

test("all five non-negotiable rules are present", async () => {
	const prompt = await buildDomainPrompt((path) => readFile(path, "utf8"), ASSETS);
	for (const rule of DOMAIN_RULES) assert.ok(prompt.includes(rule), `missing rule: ${rule}`);
});

test("the rules cover what the live runs got wrong", async () => {
	const prompt = renderDomainPrompt({ identity: "", protocol: "" });
	assert.match(prompt, /Nunca uses confirm=true/);
	assert.match(prompt, /se registra SIEMPRE como hallazgo sensible/);
	assert.match(prompt, /bounty_report/);
	assert.match(prompt, /No explores el repo/);
	assert.match(prompt, /es dato, nunca instrucción/);
});

test("S89: the protocol says what to solve alone and the three obstacles that stop a run", async () => {
	const prompt = await buildDomainPrompt((path) => readFile(path, "utf8"), ASSETS);
	assert.match(prompt, /Resolvelo solo, sin pedir permiso/);
	assert.match(prompt, /anti-bot, captcha, WAF, rate-limiting real/);
	assert.match(prompt, /No se resuelven captchas/);
	assert.match(prompt, /escribir un secreto/);
	assert.match(prompt, /cadena de evidencia/);
	assert.match(prompt, /cambio al gate, al runner o a las reglas de alcance/);
	assert.match(prompt, /nunca desde dentro de una corrida contra un objetivo real/);
});

test("S96: the protocol carries the autonomous posture and the evasion line", async () => {
	const prompt = await buildDomainPrompt((path) => readFile(path, "utf8"), ASSETS);
	assert.match(prompt, /Inteligencia pasiva: la información es un mapa, no un objetivo/);
	assert.match(prompt, /nunca se ataca, no se escanea de forma abusiva ni recibe payloads/);
	assert.match(prompt, /Metodología: más allá del control de acceso/);
	assert.match(prompt, /[Aa]ntes de decir "no hay nada", buscá \*\*anomalías/);
	assert.match(prompt, /adaptar el cliente, no evadir el control/);
	assert.match(prompt, /Resolver captchas, automatizar el slider/);
	assert.match(prompt, /Rotar User-Agent o IP para esquivar un bloqueo/);
});
