import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The kernel owns this lock for the process lifetime: no stale PID/heartbeat
// lease can permit overlapping SQLite owners after a crash or suspension.
export async function processLock(directory: string, name: string): Promise<() => Promise<void>> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const key = createHash("sha256")
		.update(`${await realpath(directory)}:${name}`)
		.digest("hex")
		.slice(0, 32);
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-mobile-${key}`
			: process.platform === "linux" || process.platform === "android"
				? `\0pi-mobile-${key}`
				: join(tmpdir(), `pi-mobile-${key}.sock`);
	const lock = createServer((socket) => socket.end());
	await new Promise<void>((done, reject) => {
		lock.once("error", reject);
		lock.listen(address, () => {
			lock.removeListener("error", reject);
			done();
		});
	});
	return () => new Promise<void>((done, reject) => lock.close((error) => (error ? reject(error) : done())));
}
