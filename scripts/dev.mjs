import { fork } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

// The supervisor lives outside every Durable worker. Backend changes may kill
// the agent doing the edit; this process still owns the restart and running set.
const root = process.cwd();
const resume = JSON.parse(process.env.PI_MOBILE_DEV_RESUME ?? "[]");
if (!Array.isArray(resume) || !resume.every((id) => typeof id === "string")) throw new Error("Invalid dev resume list");
const running = new Set(resume);
let child;
let restarting = false;
let requested = false;
let closing = false;
let timer;
const watchers = [];

function start() {
	const current = fork(resolve(root, "src/server/main.ts"), [], {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		execArgv: [],
		env: {
			...process.env,
			PI_MOBILE_DEV: "1",
			PI_MOBILE_DEV_SUPERVISOR_PID: String(process.pid),
			PI_MOBILE_DEV_RESUME: JSON.stringify([...running]),
		},
	});
	child = current;
	current.on("message", (message) => {
		if (child !== current || restarting || closing || !message || typeof message !== "object") return;
		if (message.type === "dev-worker" && typeof message.sessionId === "string") {
			if (message.running === true) running.add(message.sessionId);
			else if (message.running === false) running.delete(message.sessionId);
		}
	});
	current.on("error", (error) => console.error(`Dev server: ${error.message}`));
	current.on("close", () => {
		if (child === current) child = undefined;
		if (!closing && !restarting) schedule(2000);
	});
}

async function stop() {
	const current = child;
	if (!current) return;
	await new Promise((done) => {
		const force = setTimeout(() => current.kill("SIGKILL"), 10_000);
		current.once("close", () => {
			clearTimeout(force);
			done();
		});
		current.kill("SIGTERM");
	});
}

async function restart() {
	requested = true;
	if (restarting || closing) return;
	restarting = true;
	try {
		while (requested && !closing) {
			requested = false;
			console.log(`Pi dev: restarting backend; preserving ${running.size} running workers`);
			// Ignore shutdown's running:false events: retain the pre-restart set.
			await stop();
			if (!closing) start();
		}
	} finally {
		restarting = false;
	}
}

function schedule(ms = 500) {
	if (closing) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		void restart();
	}, ms);
}

async function close() {
	if (closing) return;
	closing = true;
	clearTimeout(timer);
	for (const watcher of watchers) watcher.close();
	await stop();
}

try {
	for (const directory of ["src/server", "src/shared", "src/worker"]) {
		const watcher = watch(resolve(root, directory), { recursive: true }, () => schedule());
		watcher.on("error", (error) => {
			console.error(`Dev watch: ${error.message}`);
			process.exitCode = 1;
			void close();
		});
		watchers.push(watcher);
	}
} catch (error) {
	for (const watcher of watchers) watcher.close();
	throw error;
}
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, () => {
		void close();
	});
process.on("SIGUSR2", () => schedule(0));
console.log(`Pi dev supervisor: ${process.pid} (SIGUSR2 requests a backend restart)`);
start();
