/**
 * A tiny HTTP "tool" for the lab (S38). It plays the role of `httpx`: it performs exactly one GET
 * against a URL and returns status/body, which the session captures as evidence. No shell, no curl,
 * no third-party client: `node:http` against 127.0.0.1 only.
 */
import { request } from "node:http";

export interface FetchResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface FetchTool {
	runTool: (argv: string[]) => Promise<FetchResult>;
	executed: string[][];
}

export function createFetchTool(): FetchTool {
	const executed: string[][] = [];
	return {
		executed,
		async runTool(argv) {
			executed.push(argv);
			const url = argv[1];
			const userIndex = argv.indexOf("--user");
			const user = userIndex >= 0 ? argv[userIndex + 1] : undefined;
			if (!url) return { exitCode: 2, stdout: "", stderr: "no url" };
			return new Promise<FetchResult>((resolve) => {
				const req = request(url, { method: "GET", headers: user === undefined ? {} : { "x-user": user } }, (res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						body += chunk;
					});
					const status = res.statusCode ?? 0;
					res.on("end", () =>
						resolve({
							exitCode: status >= 400 ? 1 : 0,
							stdout: `HTTP ${status}\n${body}`,
							stderr: "",
						}),
					);
				});
				req.on("error", (error) => resolve({ exitCode: 0, stdout: "", stderr: error.message }));
				req.end();
			});
		},
	};
}
