/**
 * S74/task 7: the runner signs each verifier invocation, and the child's session signs every execution
 * record with that invocation token. The parent can then prove mechanically that the executions it is
 * being asked to trust came from the child *it* launched, not from another session.
 *
 * The token never reaches the model: it arrives through the child's environment and is used by the
 * session code that writes the record. A forged record has no valid signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ExecutionAttestation {
	sessionId: string;
	tool: string;
	argv: string[];
	endpoint: string;
	at: string;
}

function canonical(fields: ExecutionAttestation): string {
	return [fields.sessionId, fields.tool, fields.argv.join(" "), fields.endpoint, fields.at].join("|");
}

export function signExecution(token: string, fields: ExecutionAttestation): string {
	return createHmac("sha256", token).update(canonical(fields), "utf8").digest("hex");
}

export function verifyExecutionSignature(token: string, fields: ExecutionAttestation, signature: unknown): boolean {
	if (typeof signature !== "string" || signature.length !== 64) return false;
	const expected = Buffer.from(signExecution(token, fields), "hex");
	const given = Buffer.from(signature, "hex");
	if (expected.length !== given.length) return false;
	return timingSafeEqual(expected, given);
}
