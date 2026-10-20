import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _android as android } from "playwright";

const execute = promisify(execFile);
const serial = process.env.P2W_ADB_SERIAL ?? "emulator-5572";
const output = process.env.P2W_EMULATOR_PROOF ?? "/workspace/badlogic-torture/proof/emulator/5572";
const sessionId = process.argv[2];
if (sessionId) assert(/^[a-f0-9-]+$/.test(sessionId));
await mkdir(output, { recursive: true });
const devices = await android.devices({ omitDriverInstall: true });
const device = devices.find((entry) => entry.serial() === serial);
assert(device, `Android device ${serial} is unavailable`);
device.setDefaultTimeout(600000);
const errors = [];
const screenshots = [];
try {
	const webview = await device.webView({ pkg: "dev.whamp.p2w" }, { timeout: 1200000 });
	const page = await webview.page();
	page.setDefaultTimeout(600000);
	page.on("pageerror", (error) => errors.push(String(error)));
	async function size(name) {
		await device.shell(name === "folded" ? "wm size 1080x2424" : "wm size reset");
		await device.shell("wm density 420");
		await page.waitForFunction((folded) => (folded ? innerWidth < 500 : innerWidth > 600), name === "folded");
	}
	async function capture(name) {
		const { stdout } = await execute(
			join(homedir(), "Android/Sdk/platform-tools/adb"),
			["-s", serial, "exec-out", "screencap", "-p"],
			{ encoding: "buffer", timeout: 600000, maxBuffer: 32 * 1024 * 1024 },
		);
		await writeFile(join(output, `${name}.png`), stdout);
		screenshots.push({
			name,
			at: new Date().toISOString(),
			viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })),
		});
		console.log(`Captured ${name}`);
	}
	if (!sessionId) {
		await page.getByRole("dialog", { name: "Welcome to p2w" }).waitFor();
		for (const name of ["unfolded", "folded"]) {
			await size(name);
			await capture(`${name}-onboarding`);
		}
		await page.getByRole("button", { name: "Skip for now" }).click();
		assert.match(await page.locator(".composer .chip").innerText(), /GPT-6\.1 Sol[\s\S]*high/);
		await page.locator(".composer .chip").click();
		await page.getByRole("dialog", { name: "Model", exact: true }).waitFor();
		assert.equal(await page.locator(".model-row").count(), 5);
		await writeFile(join(output, "models.txt"), await page.locator(".model-list").innerText());
		for (const name of ["folded", "unfolded"]) {
			await size(name);
			await capture(`${name}-models`);
		}
		await page
			.getByRole("dialog", { name: "Model", exact: true })
			.getByRole("button", { name: "Close", exact: true })
			.click();
	} else {
		await page.goto(`http://127.0.0.1:18787/s/${sessionId}`, { timeout: 600000 });
		const onboarding = page.getByRole("button", { name: "Skip for now" });
		if (await onboarding.isVisible()) await onboarding.click();
		await page.locator(".nested-call.error").waitFor();
		for (const name of ["folded", "unfolded"]) {
			await size(name);
			const code = page.locator(".tool-head").filter({ hasText: "Code" });
			if ((await code.getAttribute("aria-expanded")) === "true") await code.click();
			await page.locator(".nested-call.error").scrollIntoViewIfNeeded();
			await capture(`${name}-interrupted-3`);
			await code.click();
			await page.locator(".nested-call.error").scrollIntoViewIfNeeded();
			await capture(`${name}-final-result`);
		}
	}
	for (const name of ["unfolded", "folded"]) {
		await size(name);
		await device.shell("cmd statusbar expand-notifications");
		await capture(`${name}-notification`);
		await device.shell("cmd statusbar collapse");
	}
	assert.deepEqual(errors, []);
} finally {
	await writeFile(
		join(output, `${sessionId ? "session" : "setup"}-ui.json`),
		JSON.stringify({ serial, sessionId, errors, screenshots }, null, 2),
	);
	await device.close();
}
