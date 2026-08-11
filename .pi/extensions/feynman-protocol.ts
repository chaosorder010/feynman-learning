import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = join(baseDir, "..", "..", "AGENTS.md");

let cachedProtocol: string | undefined;

async function loadProtocol(): Promise<string> {
	if (cachedProtocol) return cachedProtocol;
	cachedProtocol = await readFile(protocolPath, "utf8");
	return cachedProtocol;
}

// 学习命令：/feynman-end 退出学习模式，其余命令激活当前会话。
const ACTIVATE_RE = /^\/feynman-(new-project|start|continue|review|status)(\s|$)/;
const END_RE = /^\/feynman-end(\s|$)/;

// 按 sessionId 记录“Feynman 学习模式已激活”的会话。
// 非学习场景默认不注入 AGENTS.md，避免污染上下文、节省 token。
// 会话切换天然隔离：不同 sessionId 互不影响。
const activatedSessions = new Set<string>();

function currentSessionId(ctx: unknown): string {
	const sm = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
		?.sessionManager;
	return sm?.getSessionId?.() ?? "default";
}

export default function feynmanProtocol(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = (event.prompt ?? "").trim();
		const sessionId = currentSessionId(ctx);

		const isActivate = ACTIVATE_RE.test(prompt);
		const isEnd = END_RE.test(prompt);
		const wasActivated = activatedSessions.has(sessionId);

		// 更新激活状态：/feynman-end 退出，学习命令激活。
		if (isEnd) {
			activatedSessions.delete(sessionId);
		} else if (isActivate) {
			activatedSessions.add(sessionId);
		}

		// 本轮注入条件：之前已激活，或本轮就是激活命令。
		// /feynman-end 本轮仍注入，保证教练角色完成收尾（持久化 continuation point）。
		const shouldInject = wasActivated || isActivate;
		if (!shouldInject) return undefined;

		// 防御性去重。
		if (event.systemPrompt.includes("# Feynman Learning Agent")) {
			return undefined;
		}

		const protocol = await loadProtocol();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${protocol}`,
		};
	});
}
