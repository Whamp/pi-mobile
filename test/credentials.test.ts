// Adapted cases from Pi auth-storage.test.ts (MIT); third-party/pi.LICENSE.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import lockfile, { type LockOptions } from "proper-lockfile";
import { FileCredentials } from "../src/shared/credentials.ts";
import { LockedFile } from "../src/shared/locked-file.ts";

const expired = { type: "oauth" as const, access: "expired-access", refresh: "refresh-token", expires: 0 };

test("credentials resolve scoped env/commands but enumeration never executes or exposes them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-credentials-"));
	const path = join(directory, "auth.json");
	const marker = join(directory, "marker");
	const store = new FileCredentials(path);
	try {
		await store.modify("scoped", async () => ({
			type: "api_key",
			key: "$SCOPED_KEY",
			env: { SCOPED_KEY: "scoped-secret" },
		}));
		await store.modify("command", async () => ({
			type: "api_key",
			key: `!printf command-secret; printf called >> '${marker}'`,
		}));
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(await store.list(), [
			{ providerId: "scoped", type: "api_key" },
			{ providerId: "command", type: "api_key" },
		]);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		assert.deepEqual(await store.read("scoped"), {
			type: "api_key",
			key: "scoped-secret",
			env: { SCOPED_KEY: "scoped-secret" },
		});
		assert.deepEqual(await store.read("command"), { type: "api_key", key: "command-secret" });
		assert.equal(await readFile(marker, "utf8"), "called");
		assert.equal(await store.read("toString"), undefined);
		assert.equal(await store.modify("toString", async () => undefined), undefined);
		assert(!JSON.stringify(store.metadata()).includes("secret"));
		await chmod(path, 0o660);
		const info = await stat(path);
		await store.modify("scoped", async () => ({ type: "api_key", key: "new" }));
		const updated = await stat(path);
		assert.equal(updated.ino, info.ino, "credential writes stay in-place");
		assert.equal(updated.mode & 0o777, 0o660, "existing administrator modes remain intact");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("credential modifications preserve unrelated writes and malformed files are never overwritten", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-credentials-"));
	const path = join(directory, "auth.json");
	const first = new FileCredentials(path);
	const second = new FileCredentials(path);
	try {
		await Promise.all([
			first.modify("one", async () => ({ type: "api_key", key: "one" })),
			second.modify("two", async () => ({ type: "api_key", key: "two" })),
		]);
		assert.equal((await first.list()).length, 2);
		assert.deepEqual(await first.modify("one", async () => undefined), { type: "api_key", key: "one" });
		await writeFile(path, '{"one":{"type":"api_key","key":"external"},"three":{"type":"api_key","key":"three"}}');
		await second.modify("two", async () => ({ type: "api_key", key: "updated" }));
		assert.deepEqual(await first.read("one"), { type: "api_key", key: "external" });
		assert.equal((await first.list()).length, 3);
		await first.delete("two");
		assert.equal((await second.list()).length, 2);
		await writeFile(path, "{invalid-secret-json");
		await assert.rejects(first.reload(), /Invalid auth.json syntax/);
		assert.deepEqual(
			await first.read("one"),
			{ type: "api_key", key: "external" },
			"live stores retain the last valid credential",
		);
		await assert.rejects(first.modify("other", async () => expired));
		assert.equal(await readFile(path, "utf8"), "{invalid-secret-json");
		await assert.rejects(
			new FileCredentials(path).read("one"),
			/Invalid auth.json syntax/,
			"invalid startup data fails closed",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("pre-abort and lock contention cancellation cannot create files or run a mutation later", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-credentials-"));
	const path = join(directory, "auth.json");
	try {
		const aborted = new AbortController();
		aborted.abort();
		const backend = new LockedFile(path);
		let called = false;
		await assert.rejects(
			backend.withLockAsync(
				async () => {
					called = true;
					return { result: undefined };
				},
				{ signal: aborted.signal },
			),
			{ name: "AbortError" },
		);
		assert(!called);
		await assert.rejects(stat(path), { code: "ENOENT" });
		await writeFile(path, "{}");
		const release = await lockfile.lock(path, { realpath: false });
		try {
			const controller = new AbortController();
			const pending = backend.withLockAsync(
				async () => {
					called = true;
					return { result: undefined, next: "{}" };
				},
				{ signal: controller.signal },
			);
			await delay(20);
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
		} finally {
			await release();
		}
		await delay(80);
		assert(!called);
		await backend.withLockAsync(async () => ({ result: undefined, next: "{}" }));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancelled refresh retains its lock until callback settlement, then preserves the previous token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-credentials-"));
	const path = join(directory, "auth.json");
	const store = new FileCredentials(path);
	try {
		await store.modify("oauth", async () => expired);
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const controller = new AbortController();
		const pending = store.modify(
			"oauth",
			async () => {
				started.resolve();
				await finish.promise;
				return { ...expired, access: "must-not-commit", expires: Date.now() + 60_000 };
			},
			{ signal: controller.signal },
		);
		await started.promise;
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		let competingStarted = false;
		const competing = new FileCredentials(path).modify("other", async () => {
			competingStarted = true;
			return { type: "api_key", key: "other" };
		});
		await delay(50);
		assert(!competingStarted);
		finish.resolve();
		await competing;
		assert.deepEqual(await store.read("oauth"), expired);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("compromised locks reject without writing", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-credentials-"));
	const path = join(directory, "auth.json");
	try {
		await writeFile(path, "{}");
		let releases = 0;
		t.mock.method(lockfile, "lock", async (_path: string, options?: LockOptions) => {
			options?.onCompromised?.(new Error("Compromised test lock"));
			return async () => {
				releases++;
			};
		});
		let called = false;
		await assert.rejects(
			new LockedFile(path).withLockAsync(async () => {
				called = true;
				return { result: undefined, next: '{"invalid":true}' };
			}),
			/Compromised test lock/,
		);
		assert(!called);
		assert.equal(releases, 1);
		assert.equal(await readFile(path, "utf8"), "{}");
	} finally {
		t.mock.restoreAll();
		await rm(directory, { recursive: true, force: true });
	}
});

test(
	"two processes refresh one expired OAuth credential only once under the shared file lock",
	{ timeout: 20_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-refresh-"));
		const path = join(directory, "auth.json");
		const counter = join(directory, "counter");
		await new FileCredentials(path).modify("test-oauth", async () => expired);
		const children = [0, 1].map(() =>
			fork(new URL("./fixtures/credential-process.ts", import.meta.url), [path, counter], {
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			}),
		);
		try {
			const ready = children.map(
				(child) =>
					new Promise<void>((done, reject) => {
						child.once("error", reject);
						child.on("message", (message: { type: string }) => {
							if (message.type === "ready") done();
						});
						child.stderr?.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
					}),
			);
			const done = children.map(
				(child) =>
					new Promise<void>((resolve, reject) => {
						child.on("message", (message: { type: string; ok?: boolean }) => {
							if (message.type === "done") {
								if (message.ok) resolve();
								else reject(new Error("Refresh fixture failed"));
							}
						});
					}),
			);
			await Promise.all(ready);
			for (const child of children) child.send("go");
			await Promise.all(done);
			assert.equal(await readFile(counter, "utf8"), "refresh\n");
			const credential = await new FileCredentials(path).read("test-oauth");
			assert(credential?.type === "oauth");
			assert.equal(credential.refresh, "rotated-refresh");
		} finally {
			await Promise.all(
				children.map(
					(child) =>
						new Promise<void>((done) => {
							if (child.exitCode !== null || child.signalCode !== null) {
								done();
								return;
							}
							child.once("close", done);
							child.kill("SIGTERM");
						}),
				),
			);
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("credential shutdown drains a cancelled acquisition through release before exiting", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-close-"));
	const path = join(directory, "auth.json");
	const store = new FileCredentials(path);
	const entered = Promise.withResolvers<void>();
	const acquired = Promise.withResolvers<void>();
	const releaseStarted = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	try {
		await store.modify("oauth", async () => expired);
		t.mock.method(lockfile, "lock", async () => {
			entered.resolve();
			await acquired.promise;
			return async () => {
				releaseStarted.resolve();
				await released.promise;
			};
		});
		const controller = new AbortController();
		let mutated = false;
		const pending = store.modify(
			"oauth",
			async () => {
				mutated = true;
				return { ...expired, access: "must-not-commit" };
			},
			{ signal: controller.signal },
		);
		await entered.promise;
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await delay(20);
		assert(!closed);
		acquired.resolve();
		await releaseStarted.promise;
		assert(!closed && !mutated);
		released.resolve();
		await closing;
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { oauth: expired });
	} finally {
		acquired.resolve();
		released.resolve();
		await store.close();
		t.mock.restoreAll();
		await rm(directory, { recursive: true, force: true });
	}
});

test("provider-owned refresh failures preserve tokens and cannot fall back to API-key auth", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-refresh-"));
	const path = join(directory, "auth.json");
	const store = new FileCredentials(path);
	try {
		await store.modify("test-oauth", async () => expired);
		let fallback = false;
		const provider: Provider = {
			id: "test-oauth",
			name: "Test",
			getModels: () => [],
			auth: {
				apiKey: {
					name: "Fallback",
					resolve: async () => {
						fallback = true;
						return { auth: { apiKey: "wrong" } };
					},
				},
				oauth: {
					name: "Test",
					login: async () => {
						throw new Error("Unused");
					},
					refresh: async () => {
						throw new Error("Failed refresh");
					},
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			stream: () => {
				throw new Error("Unused");
			},
			streamSimple: () => {
				throw new Error("Unused");
			},
		};
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		await assert.rejects(models.getAuth(provider.id), { code: "oauth" });
		assert(!fallback);
		assert.deepEqual(await store.read(provider.id), expired);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
