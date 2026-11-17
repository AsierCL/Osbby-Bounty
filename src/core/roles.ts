/**
 * S106: the authorization matrix needs more than one session.
 *
 * `session.headers` is the human's single session; the matrix needs A, B, anonymous and maybe an
 * admin, side by side. They live in `work/<program>/sessions/<role>.headers`, one flat file per role,
 * written by the operator, never by the model.
 *
 * The decision behind the flat file is the operator's: this host is a personal raspberry, the files
 * are `0600` under `work/` (gitignored), and every account is a disposable test account. No keyring,
 * no vault, no dependency. What still holds, and is not negotiable:
 *
 * - the credential never enters argv, so it never enters the evidence chain;
 * - the model never reads the value: `list`/`check` report header NAMES, and the file is injected
 *   into curl through a private config, exactly like the single session file already works.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { duplicatedHeaderNames, parseHeaderLines, type HeaderLine } from "./headers.ts";

export const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface RoleInfo {
	role: string;
	headerNames: string[];
	bytes: number;
	updatedAt: string | null;
	warnings: string[];
}

export interface RoleSession {
	role: string;
	headers: HeaderLine[];
}

export interface RoleStore {
	/** Roles present, with header NAMES only. Never a value. */
	list(): Promise<RoleInfo[]>;
	/** The parsed headers of one role. Used to inject, never to render. */
	read(role: string): Promise<RoleSession | null>;
	/** Operator helper (scripts/set-role.ts). Not exposed as a model tool. */
	write(role: string, text: string): Promise<RoleInfo>;
	file(role: string): string;
}

export function normalizeRoleName(raw: string): string {
	const role = raw.trim().toLowerCase();
	if (!ROLE_NAME.test(role)) {
		throw new Error(`nombre de rol inválido: "${raw}". Usá minúsculas, números, guion y guion bajo (máximo 41 caracteres), sin barras.`);
	}
	return role;
}

function warningsFor(headers: HeaderLine[]): string[] {
	const warnings: string[] = [];
	const names = headers.map((header) => header.name.toLowerCase());
	if (!names.includes("cookie") && !names.includes("authorization")) {
		warnings.push("no tiene Cookie ni Authorization: probablemente no autentique nada");
	}
	const duplicated = duplicatedHeaderNames(headers);
	if (duplicated.length > 0) warnings.push(`header duplicado: ${duplicated.join(", ")}`);
	return warnings;
}

export function createRoleStore(options: { workspace: string }): RoleStore {
	const dir = join(options.workspace, "sessions");

	function file(role: string): string {
		return join(dir, `${normalizeRoleName(role)}.headers`);
	}

	async function read(role: string): Promise<RoleSession | null> {
		try {
			const text = await readFile(file(role), "utf8");
			const headers = parseHeaderLines(text);
			if (headers.length === 0) return null;
			return { role: normalizeRoleName(role), headers };
		} catch {
			return null;
		}
	}

	return {
		file,

		async list() {
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return [];
			}
			const roles: RoleInfo[] = [];
			for (const name of names.sort()) {
				if (!name.endsWith(".headers")) continue;
				const role = name.slice(0, -".headers".length);
				if (!ROLE_NAME.test(role)) continue;
				let text: string;
				try {
					text = await readFile(join(dir, name), "utf8");
				} catch {
					continue;
				}
				const headers = parseHeaderLines(text);
				const info = await stat(join(dir, name)).catch(() => null);
				roles.push({
					role,
					headerNames: [...new Set(headers.map((header) => header.name))],
					bytes: Buffer.byteLength(text, "utf8"),
					updatedAt: info === null ? null : new Date(info.mtimeMs).toISOString(),
					warnings: warningsFor(headers),
				});
			}
			return roles;
		},

		read,

		async write(role, text) {
			await mkdir(dir, { recursive: true });
			const target = file(role);
			await writeFile(target, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
			const headers = parseHeaderLines(text);
			const info = await stat(target);
			return {
				role: normalizeRoleName(role),
				headerNames: [...new Set(headers.map((header) => header.name))],
				bytes: Buffer.byteLength(text, "utf8"),
				updatedAt: new Date(info.mtimeMs).toISOString(),
				warnings: warningsFor(headers),
			};
		},
	};
}
