import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { verifyTorture } from "../src/shared/torture.ts";
import { Client, until } from "../test/client.ts";
import { codemodeResult } from "./torture.ts";

const output = process.env.P2W_WEB_PROOF ?? "/workspace/badlogic-torture/proof/web";
const app = resolve("android/.generated/app");
const sizes = { folded: { width: 412, height: 915 }, unfolded: { width: 840, height: 900 } };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const directory = await mkdtemp(join(tmpdir(), "p2w-web-proof-"));
let child;
let exit;
let observer;
let heartbeat;
let serverLog = "";
const errors = [];
const events = [];
async function start(fake) {
	let boot = "";
	child = spawn(process.execPath, [join(app, "src/server/main.js")], {
		cwd: directory,
		env: {
			PATH: process.env.PATH,
			HOME: directory,
			TMPDIR: directory,
			PORT: "0",
			PI_MOBILE_DATA_DIR: join(directory, fake ? "fake" : "real"),
			PI_MOBILE_PROFILE: "p2w",
			PI_MOBILE_WEB_DIR: join(app, "web"),
			PI_MOBILE_FAKE: fake ? "1" : "0",
			PI_MOBILE_DEBUG: "1",
			PI_MOBILE_TORTURE_SLEEP: "10",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	exit = new Promise((done) => child.once("exit", done));
	child.stdout.on("data", (chunk) => {
		boot += chunk;
		serverLog += chunk;
	});
	child.stderr.on("data", (chunk) => {
		serverLog += chunk;
	});
	await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(boot));
	return boot.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
}
async function stop() {
	child?.kill("SIGTERM");
	await Promise.race([exit, delay(5000)]);
	if (child?.exitCode === null) child.kill("SIGKILL");
}
async function pageFor(context, url) {
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(url);
	return page;
}
try {
	const realUrl = await start(false);
	for (const [name, viewport] of Object.entries(sizes)) {
		const context = await browser.newContext({ viewport });
		const page = await pageFor(context, realUrl);
		await page.getByRole("dialog", { name: "Welcome to p2w" }).waitFor();
		await page.screenshot({ path: join(output, `${name}-onboarding.png`) });
		await page.getByRole("button", { name: "Skip for now" }).click();
		await page.locator(".composer .chip").click();
		await page.getByRole("dialog", { name: "Model", exact: true }).waitFor();
		assert.equal(await page.locator(".model-row").count(), 5);
		await writeFile(join(output, `${name}-models.txt`), await page.locator(".model-list").innerText());
		await page.screenshot({ path: join(output, `${name}-models.png`) });
		await context.close();
	}
	await stop();
	const url = await start(true);
	observer = await Client.connect(url);
	const context = await browser.newContext({
		viewport: sizes.folded,
		recordVideo: { dir: output, size: sizes.folded },
	});
	const page = await pageFor(context, url);
	const video = page.video();
	await page.getByRole("button", { name: "Skip for now" }).click();
	const runId = `web-${randomUUID()}`;
	await page.getByRole("textbox", { name: "Message", exact: true }).fill(`torture ${runId}`);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.waitForURL(/\/s\//);
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	await observer.request({ type: "open", sessionId });
	heartbeat = setInterval(() => {
		void observer.request({ type: "heartbeat", sessionId }).catch(() => {});
	}, 10000);
	await until(
		() =>
			observer.views
				.get(sessionId)
				?.docs["pi.live"]?.nestedTools?.some(
					(call) => call.status === "running" && call.arguments.command?.includes('echo "3 '),
				),
		90000,
	);
	events.push({ at: new Date().toISOString(), type: "call-3-running", worker: observer.workers.get(sessionId) });
	const before = observer.views.get(sessionId);
	await page.getByRole("button", { name: "Session options" }).click();
	await page
		.getByRole("dialog", { name: "Session", exact: true })
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await page.waitForURL(`${url}/`);
	await page.getByRole("button", { name: "Sessions", exact: true }).click();
	await page.getByRole("button", { name: "Archived", exact: true }).click();
	await page.locator(".session-main").filter({ hasText: runId }).click();
	await page.waitForURL(/\/s\//);
	await observer.request({ type: "open", sessionId });
	events.push({ at: new Date().toISOString(), type: "restored-from-ui", worker: observer.workers.get(sessionId) });
	await page.locator(".nested-call.error").waitFor();
	await page.locator(".nested-call.error").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(output, "folded-interrupted-3.png") });
	const wide = await browser.newContext({ viewport: sizes.unfolded });
	await wide.addInitScript(() => localStorage.setItem("p2w-onboarded", "1"));
	const widePage = await pageFor(wide, page.url());
	await widePage.locator(".nested-call.error").waitFor();
	await widePage.locator(".nested-call.error").scrollIntoViewIfNeeded();
	await widePage.screenshot({ path: join(output, "unfolded-interrupted-3.png") });
	await until(() => codemodeResult(observer.views.get(sessionId)) !== undefined, 240000);
	const view = observer.views.get(sessionId);
	const completed = codemodeResult(view);
	const users = view.entries.filter((entry) => entry.kind === "pi.user");
	const verdict = verifyTorture(
		completed.value,
		users.length === 1 &&
			users[0].id === before.entries.find((entry) => entry.kind === "pi.user").id &&
			view.conversation.id === before.conversation.id,
	);
	assert(Object.values(verdict).every(Boolean), JSON.stringify(verdict));
	assert.equal(completed.calls.length, 14);
	assert.equal(
		completed.value.log,
		await readFile(join(directory, "durable-codemode", `restart-${runId}.log`), "utf8"),
	);
	for (const [name, target] of [
		["folded", page],
		["unfolded", widePage],
	]) {
		await target.locator(".tool-head").filter({ hasText: "Code" }).click();
		await target.locator(".nested-call.error").scrollIntoViewIfNeeded();
		await target.screenshot({ path: join(output, `${name}-final-result.png`) });
		await writeFile(join(output, `${name}-final.txt`), await target.locator(".scroller").innerText());
	}
	await writeFile(
		join(output, "results.json"),
		JSON.stringify(
			{
				runId,
				sessionId,
				conversationId: view.conversation.id,
				verdict,
				calls: completed.calls,
				...completed.value,
				errors,
				events,
			},
			null,
			2,
		),
	);
	await wide.close();
	await context.close();
	await video.saveAs(join(output, "folded-torture-archive-restore.webm"));
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ output, sessionId, verdict }));
} finally {
	clearInterval(heartbeat);
	await observer?.close();
	await browser.close();
	await stop();
	await writeFile(join(output, "server.log"), serverLog);
	await writeFile(join(output, "events.json"), JSON.stringify({ errors, events }, null, 2));
	await rm(directory, { recursive: true, force: true });
}
