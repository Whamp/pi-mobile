export const INTERRUPTED_BASH = "Tool bash was interrupted and may have partially run";

export type TortureResult = { results: string[]; log: string };

export function tortureScript(runId: string, sleepSeconds = 10): string {
	if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid torture run ID");
	if (!Number.isFinite(sleepSeconds) || sleepSeconds <= 0) throw new Error("Invalid torture sleep");
	return `const RUN = ${JSON.stringify(runId)};
const D = '"\${TMPDIR:-/tmp}/durable-codemode"';
const results = [];
await tools.bash({ command: \`mkdir -p \${D} && echo "start \${RUN} $(hostname) $(date +%T)" >> \${D}/restart-\${RUN}.log\` });
for (let i = 1; i <= 12; i++) {
  try {
    await tools.bash({ command: \`sleep ${sleepSeconds}; echo "\${i} $(date +%T)" >> \${D}/restart-\${RUN}.log; echo \${i}\` });
    results.push(\`\${i}: ok\`);
  } catch (e) {
    results.push(\`\${i}: error \${e.message.split("\\n")[0]}\`);
  }
}
const log = await tools.bash({ command: \`cat \${D}/restart-\${RUN}.log\` });
return { results, log: log.output };`;
}

export function verifyTorture(result: TortureResult, sameSubmission: boolean) {
	const lines = result.log.trim().split("\n");
	const counts = Array.from(
		{ length: 12 },
		(_, index) => lines.filter((line) => line.startsWith(`${index + 1} `)).length,
	);
	return {
		P1:
			lines.filter((line) => line.startsWith("start ")).length === 1 &&
			counts.every((count) => count <= 1) &&
			result.results.every((row, index) => row !== `${index + 1}: ok` || counts[index] === 1),
		P2: result.results[2] === `3: error ${INTERRUPTED_BASH}` && counts[2] <= 1,
		P3:
			result.results.length === 12 &&
			result.results.every((row, index) => index === 2 || row === `${index + 1}: ok`),
		P4: sameSubmission,
	};
}
