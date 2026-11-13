/**
 * S76/task 2: what a verifier verdict is allowed to mean.
 *
 * A verdict is evidence only when the verifier's own signed executions produced a complete HTTP
 * response. If the instrument could not run — no signed execution, connection refused, timeout, no
 * status — the effective verdict is INCONCLUSO and the finding does not move.
 *
 * The three verdicts:
 * - REPRODUCIDO: at least one complete signed execution against the endpoint => verified.
 * - NO_REPRODUCIDO over a candidate => rejected; over a verified finding => disputed (the operator
 *   resolves a dispute; it never degrades itself).
 * - INCONCLUSO: nothing changes, and status.md says why.
 */
import { verifyExecutionSignature } from "./attestation.ts";
import type { EvidenceRecord } from "./evidence.ts";
import type { FindingState } from "./findings.ts";
import { statusAndBody } from "./report.ts";

export type Verdict = "REPRODUCIDO" | "NO_REPRODUCIDO" | "INCONCLUSO";

export interface InspectedExecution {
	seq: number;
	endpoint: string;
	signed: boolean;
	exitCode: number | null;
	status: string | null;
	complete: boolean;
}

export interface Inspection {
	executions: InspectedExecution[];
	/** Executions whose signature matches this invocation. */
	signed: InspectedExecution[];
	/** Signed executions that got a full HTTP response (exit 0 and an HTTP status). */
	complete: InspectedExecution[];
}

/** Reads the executions the verifier's own session wrote, pairing each with its result. */
export function inspectVerifierExecutions(
	records: EvidenceRecord[],
	input: { verifierSessionId: string; token: string | undefined; endpoint: string },
): Inspection {
	const bySeq = new Map(records.map((record) => [record.seq, record]));
	const executions: InspectedExecution[] = [];
	for (const record of records) {
		if (record.kind !== "execution") continue;
		const payload = record.payload as { sessionId?: string; signature?: string; tool?: string; argv?: string[]; endpoint?: string; at?: string };
		if (payload.sessionId !== input.verifierSessionId) continue;
		const endpoint = payload.endpoint ?? "";
		const matches = endpoint === input.endpoint || (payload.argv ?? []).join(" ").includes(input.endpoint);
		if (!matches) continue;
		const signed =
			input.token !== undefined &&
			input.token.length > 0 &&
			verifyExecutionSignature(
				input.token,
				{ sessionId: input.verifierSessionId, tool: payload.tool ?? "", argv: payload.argv ?? [], endpoint, at: payload.at ?? "" },
				payload.signature,
			);
		const next = bySeq.get(record.seq + 1);
		const result = next !== undefined && next.kind === "execution-result" ? (next.payload as { exitCode?: number; stdout?: string }) : null;
		const stdout = typeof result?.stdout === "string" ? result.stdout : "";
		const { status } = statusAndBody(stdout);
		const exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
		executions.push({
			seq: record.seq,
			endpoint,
			signed,
			exitCode,
			status,
			complete: signed && exitCode === 0 && status !== null,
		});
	}
	return {
		executions,
		signed: executions.filter((execution) => execution.signed),
		complete: executions.filter((execution) => execution.complete),
	};
}

/** Why the instrument could not produce a complete result. */
function incompleteReason(inspection: Inspection): string {
	if (inspection.signed.length === 0) return "sin ejecuciones firmadas de la sesión del verificador";
	const failed = inspection.signed.filter((execution) => execution.exitCode !== 0);
	if (failed.length > 0) {
		return `conexión rechazada o timeout (exit ${failed.map((execution) => execution.exitCode ?? "?").join(", ")})`;
	}
	return "sin estado HTTP en la respuesta del verificador (usa curl -i o agrega -w '\\n%{http_code}')";
}

export interface Decision {
	effective: Verdict;
	converted: boolean;
	nextState: FindingState | null;
	event: "verified" | "rejected" | "disputed" | "inconclusive";
	detail: string;
}

export function decideVerdict(input: {
	verdict: Verdict | null;
	seqs: number[];
	reason: string;
	state: FindingState;
	inspection: Inspection;
	/** The runner gave no token: nothing can be attributed to this invocation. */
	tokenMissing?: boolean;
}): Decision {
	const reason = input.reason.trim();
	const suffix = reason.length === 0 ? "" : ` Motivo del verificador: ${reason}`;
	const inconclusive = (detail: string): Decision => ({
		effective: "INCONCLUSO",
		converted: input.verdict !== "INCONCLUSO" && input.verdict !== null,
		nextState: null,
		event: "inconclusive",
		detail: `${detail}.${suffix}`,
	});

	if (input.verdict === null) return inconclusive("El verificador no devolvió un veredicto legible");
	if (input.tokenMissing === true && input.verdict !== "INCONCLUSO") {
		return inconclusive("INCONCLUSO: falta el token de invocación, así que no puedo demostrar que las ejecuciones sean de esta invocación del verificador");
	}
	if (input.verdict === "INCONCLUSO") {
		return { effective: "INCONCLUSO", converted: false, nextState: null, event: "inconclusive", detail: `INCONCLUSO: el hallazgo no cambia.${suffix}` };
	}
	if (input.inspection.complete.length === 0) return inconclusive(`INCONCLUSO: el verificador no produjo ninguna respuesta completa (${incompleteReason(input.inspection)})`);

	if (input.verdict === "REPRODUCIDO") {
		const claimed = input.seqs.length === 0 ? input.inspection.complete : input.inspection.complete.filter((execution) => input.seqs.includes(execution.seq));
		if (claimed.length === 0) {
			return inconclusive(`INCONCLUSO: las ejecuciones citadas (${input.seqs.join(", ")}) no tienen respuesta HTTP completa`);
		}
		const seqs = claimed.map((execution) => execution.seq).join(", ");
		return {
			effective: "REPRODUCIDO",
			converted: false,
			nextState: "verified",
			event: "verified",
			detail: `REPRODUCIDO: verified con la evidencia seq ${seqs} firmada por la sesión del verificador.${suffix}`,
		};
	}

	// NO_REPRODUCIDO with a complete signed execution: it counts, but it may not degrade a verified finding.
	if (input.state === "candidate") {
		return { effective: "NO_REPRODUCIDO", converted: false, nextState: "rejected", event: "rejected", detail: `NO_REPRODUCIDO: el hallazgo pasó a rejected.${suffix}` };
	}
	if (input.state === "verified") {
		return {
			effective: "NO_REPRODUCIDO",
			converted: false,
			nextState: "disputed",
			event: "disputed",
			detail: `NO_REPRODUCIDO sobre un hallazgo verificado: quedó en disputed y lo resuelve el operador, no el código.${suffix}`,
		};
	}
	return inconclusive(`INCONCLUSO: el veredicto dice NO_REPRODUCIDO pero el hallazgo está en ${input.state} y este código no lo degrada`);
}
