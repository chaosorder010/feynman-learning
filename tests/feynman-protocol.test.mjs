import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

async function loadJiti() {
	try {
		return await import("jiti");
	} catch {
		for (const binDir of (process.env.PATH || "").split(":").filter(Boolean)) {
			const candidate = join(
				binDir,
				"..",
				"lib",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"node_modules",
				"jiti",
				"lib",
				"jiti.mjs",
			);
			try {
				await access(candidate);
				return await import(candidate);
			} catch {
				// Try the next PATH entry.
			}
		}
		throw new Error("Install devDependencies or run tests with Pi's vendored jiti available on PATH.");
	}
}

const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const feynmanProtocol = await jiti.import("../.pi/extensions/feynman-protocol.ts", { default: true });

const MARKER = "# Feynman Learning Agent";

// 每个用例用唯一 sessionId，避免模块级 activatedSessions 跨用例污染。
let seq = 0;
const sid = () => `s${++seq}`;

function harness(sessionId) {
	let handler = null;
	const pi = { on: (_event, h) => { handler = h; } };
	feynmanProtocol(pi);
	const ctx = { sessionManager: { getSessionId: () => sessionId } };
	async function call(prompt, basePrompt = "BASE") {
		const event = {
			type: "before_agent_start",
			prompt,
			systemPrompt: basePrompt,
			systemPromptOptions: {},
		};
		return handler(event, ctx);
	}
	return { call };
}

function injected(result) {
	return Boolean(result?.systemPrompt?.includes(MARKER));
}

console.log("feynman-protocol: on-demand injection");

await (async () => {
	const { call } = harness(sid());
	const r = await call("帮我看看这个函数");
	assert.equal(injected(r), false);
	console.log("  ✓ 未激活时普通输入不注入");
})();

await (async () => {
	const { call } = harness(sid());
	const r = await call("/start llm");
	assert.equal(injected(r), true);
	console.log("  ✓ /start 激活并注入");
})();

await (async () => {
	const { call } = harness(sid());
	await call("/start llm");
	const r = await call("这个概念什么意思");
	assert.equal(injected(r), true);
	console.log("  ✓ 激活后普通输入粘性注入");
})();

await (async () => {
	const { call } = harness(sid());
	await call("/start llm");
	const rEnd = await call("/end llm");
	assert.equal(injected(rEnd), true);
	const rAfter = await call("随便聊聊");
	assert.equal(injected(rAfter), false);
	console.log("  ✓ /end 本轮仍注入，之后退出学习模式");
})();

await (async () => {
	const a = sid();
	const b = sid();
	const ha = harness(a);
	const hb = harness(b);
	await ha.call("/start llm");
	const rb = await hb.call("普通问题");
	assert.equal(injected(rb), false);
	console.log("  ✓ 会话隔离：A 激活不污染 B");
})();

await (async () => {
	const { call } = harness(sid());
	const r = await call("/status llm");
	assert.equal(injected(r), true);
	console.log("  ✓ /status 也激活");
})();

await (async () => {
	const { call } = harness(sid());
	const r = await call("/help");
	assert.equal(injected(r), false);
	console.log("  ✓ 非学习命令 /help 不激活");
})();

await (async () => {
	const { call } = harness(sid());
	await call("/start llm");
	const r = await call("继续", `PREFIX ${MARKER} SUFFIX`);
	assert.equal(r, undefined);
	console.log("  ✓ 已含标记则防御性跳过重复注入");
})();

await (async () => {
	const { call } = harness(sid());
	const r = await call("/startup something");
	assert.equal(injected(r), false);
	console.log("  ✓ /startup 不误匹配 /start");
})();

console.log("all feynman-protocol checks passed");
