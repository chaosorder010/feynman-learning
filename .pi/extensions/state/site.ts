import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	slugify,
	projectDir,
	progressPath,
	nowStamp,
	readJson,
	readText,
	reservedProjectValidation,
	validationFailureResult,
} from "./util.js";
import { readConceptIndex, entryNodeSlug } from "./concept-index.js";
import type { ConceptIndexEntry } from "./concept-index.js";
import { isReviewDue, daysOverdue, REVIEW_GRADUATED_STAGE, REVIEW_CADENCE_DAYS } from "./review-scheduler.js";

const SITE_CSS = `
:root {
  --paper: #fdfcf9; --card: #ffffff; --ink: #1c1c1c;
  --muted: #555555; --faint: #8a8a8a;
  --rule: #e0ddd5; --rule-strong: #b8b4aa;
  --def: #8a6d3b; --def-bg: #faf6ee;
  --intu: #5b7f67; --intu-bg: #f2f6f3;
  --warn: #a05c3c; --warn-bg: #faf3ef;
  --key: #5d5f8a; --key-bg: #f3f3f8;
  --code-bg: #f5f3ef; --radius: 6px;
  --font-main: "Maple Mono NF CN", "Maple Mono CN", "Maple Mono",
    "HarmonyOS Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", monospace;
}
* { box-sizing: border-box; }
html { font-size: 16px; -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 3rem 1.5rem 6rem; background: var(--paper); color: var(--ink);
  font-family: var(--font-main); line-height: 1.8; font-size: 1rem; }
.page { max-width: 720px; margin: 0 auto; }
.site-header { border-bottom: 4px solid var(--rule-strong); padding-bottom: 1.2rem; margin-bottom: 2rem; }
.site-header .eyebrow { font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin: 0 0 .4rem; }
.site-header h1 { font-size: 1.6rem; margin: 0 0 .5rem; line-height: 1.4; }
.site-header .meta { color: var(--muted); font-size: .9rem; }
.state-badge { display: inline-block; padding: .1rem .6rem; border-radius: var(--radius);
  background: var(--key-bg); color: var(--key); font-size: .8rem; }
.card { background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius);
  padding: 1.1rem 1.3rem; margin: 0 0 1.4rem; }
.card h2 { font-size: 1.02rem; margin: 0 0 .8rem; color: var(--ink); }
.card h2 .count { color: var(--faint); font-weight: normal; font-size: .85rem; }
.progress-track { background: var(--code-bg); border-radius: var(--radius); height: 12px; overflow: hidden; margin: .4rem 0 .6rem; }
.progress-fill { background: var(--intu); height: 100%; border-radius: var(--radius); }
.progress-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: .85rem; }
.due-item { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
  padding: .5rem 0; border-bottom: 1px dashed var(--rule); }
.due-item:last-child { border-bottom: none; }
.due-item .tag { font-size: .78rem; color: var(--warn); white-space: nowrap; }
.due-item .node { color: var(--faint); font-size: .8rem; }
.empty { color: var(--faint); font-style: italic; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--rule); }
th { color: var(--muted); font-weight: 600; border-bottom: 2px solid var(--rule-strong); }
.node-row { border-bottom: 2px solid var(--rule); }
.node-row .node-name { font-weight: 600; }
.badge { display: inline-block; padding: 0 .45rem; border-radius: var(--radius); font-size: .78rem; }
.badge.passed { background: var(--intu-bg); color: var(--intu); }
.badge.active { background: var(--def-bg); color: var(--def); }
.badge.todo { background: var(--code-bg); color: var(--faint); }
.badge.remediating { background: var(--warn-bg); color: var(--warn); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .8rem; }
.stat { background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius); padding: .8rem 1rem; }
.stat .num { font-size: 1.4rem; font-weight: 600; }
.stat .lbl { color: var(--muted); font-size: .8rem; }
.footer { color: var(--faint); font-size: .78rem; text-align: center; margin-top: 3rem; }
a { color: var(--key); text-decoration: none; }
a:hover { text-decoration: underline; }
@media print { body { padding: 1rem; } .card { break-inside: avoid; } }
`;

function escHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtDate(iso: string | undefined): string {
	if (!iso) return "-";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "-";
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type OutlineNodeInfo = { title: string; slug: string };

function parseOutlineNodes(outlineText: string | undefined): OutlineNodeInfo[] {
	if (!outlineText) return [];
	const nodes: OutlineNodeInfo[] = [];
	for (const line of outlineText.split("\n")) {
		const m = line.match(/^###\s+(N\d+)\s*[--]?\s*(.+)$/);
		if (m) nodes.push({ title: `${m[1]} - ${m[2].trim()}`, slug: m[1].trim().toLowerCase() });
	}
	return nodes;
}

async function readOutline(project: string): Promise<string | undefined> {
	try {
		return await readText(join(projectDir(project), "outline.md"));
	} catch {
		return undefined;
	}
}

async function buildSite(project: string): Promise<string> {
	const dir = projectDir(project);
	const siteDir = join(dir, "site");
	await mkdir(siteDir, { recursive: true });

	const progress = await readJson(progressPath(project), { project, completed_nodes: [] });
	const { concepts } = await readConceptIndex(project);
	const outlineText = await readOutline(project);
	const outlineNodes = parseOutlineNodes(outlineText);
	const now = nowStamp();

	const completedNodes = new Set<string>(
		(Array.isArray(progress.completed_nodes) ? progress.completed_nodes : []).map((n: any) => String(n).toLowerCase()),
	);
	const currentNode = String(progress.current_outline_node || "").toLowerCase();

	const passedConcepts = concepts.filter((c) => c.last_outcome === "passed");
	const remediatingConcepts = concepts.filter((c) => c.last_outcome === "remediating");
	const dueConcepts = concepts
		.filter((c) => isReviewDue(c.review_schedule, now))
		.sort((a, b) => (a.review_schedule?.next_review_at || "").localeCompare(b.review_schedule?.next_review_at || ""));
	const scores = Array.isArray(progress.scores) ? (progress.scores as any[]) : [];
	const averages = scores.filter((s) => typeof s?.average === "number").map((s) => s.average as number);
	const avgScore = averages.length ? (averages.reduce((a, b) => a + b, 0) / averages.length).toFixed(2) : "-";
	const passCount = scores.filter((s) => s?.passed === true).length;

	// ---- outline table rows (concept counts per node) ----
	const conceptsByNode = new Map<string, ConceptIndexEntry[]>();
	for (const c of concepts) {
		const key = entryNodeSlug(c);
		const list = conceptsByNode.get(key) || [];
		list.push(c);
		conceptsByNode.set(key, list);
	}
	const outlineRows = outlineNodes.map((node) => {
		const nodeConcepts = conceptsByNode.get(node.slug) || [];
		const passed = nodeConcepts.filter((c) => c.last_outcome === "passed").length;
		const total = nodeConcepts.length;
		const status = completedNodes.has(node.slug) ? "passed" : currentNode === node.slug ? "active" : "todo";
		const statusBadge =
			status === "passed"
				? '<span class="badge passed">完成</span>'
				: status === "active"
					? '<span class="badge active">进行中</span>'
					: '<span class="badge todo">待学</span>';
		return `<tr class="node-row"><td class="node-name">${escHtml(node.title)}</td><td>${total ? `${passed}/${total}` : "-"}</td><td>${statusBadge}</td></tr>`;
	}).join("\n");

	// ---- concept table ----
	const conceptRows = concepts
		.slice()
		.sort((a, b) => a.outline_node.localeCompare(b.outline_node) || a.concept.localeCompare(b.concept))
		.map((c) => {
			const outcome = c.last_outcome || "new";
			const badge =
				outcome === "passed"
					? '<span class="badge passed">通过</span>'
					: outcome === "remediating"
						? '<span class="badge remediating">补救中</span>'
						: '<span class="badge todo">学习中</span>';
			const avg = c.last_score?.average !== undefined ? `${c.last_score.average.toFixed(1)}` : "-";
			const due = c.review_schedule?.next_review_at
				? fmtDate(c.review_schedule.next_review_at)
				: "-";
			const stage = c.review_schedule?.stage !== undefined ? `S${c.review_schedule.stage}` : "-";
			return `<tr><td>${escHtml(c.outline_node)}</td><td>${escHtml(c.concept)}</td><td>${badge}</td><td>${avg}</td><td>${stage}</td><td>${due}</td></tr>`;
		})
		.join("\n");

	// ---- due review items ----
	const dueItems =
		dueConcepts.length === 0
			? '<div class="empty">今天没有到期的复习 🎉</div>'
			: dueConcepts
					.map((c) => {
						const overdue = daysOverdue(c.review_schedule, now);
						const stageLabel = c.review_schedule?.stage ?? 0;
						const nextLabel =
							stageLabel < REVIEW_GRADUATED_STAGE ? `${REVIEW_CADENCE_DAYS[stageLabel]}天后` : "毕业";
						return `<div class="due-item"><span><strong>${escHtml(c.concept)}</strong> <span class="node">(${escHtml(c.outline_node)})</span></span><span class="tag">${overdue > 0 ? `超期 ${overdue} 天 · ` : ""}下一轮 ${nextLabel}</span></div>`;
					})
					.join("\n");

	// ---- stats ----
	const totalConcepts = concepts.length;
	const nodeTotal = outlineNodes.length;
	const nodeDone = outlineNodes.filter((n) => completedNodes.has(n.slug)).length;
	const progressPct = nodeTotal ? Math.round((nodeDone / nodeTotal) * 100) : 0;

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(progress.project || project)} · 学习仪表盘</title>
<style>${SITE_CSS}</style>
</head>
<body>
<div class="page">
  <header class="site-header">
    <p class="eyebrow">Feynman Learning Project</p>
    <h1>🎓 ${escHtml(progress.project || project)}</h1>
    <div class="meta">当前状态: <span class="state-badge">${escHtml(progress.current_state || "NEW")}</span>
      ${progress.current_concept ? ` · 当前概念: <strong>${escHtml(progress.current_concept)}</strong>` : ""}</div>
  </header>

  <div class="card">
    <h2>📈 学习进度 <span class="count">${nodeDone}/${nodeTotal} 节点 · ${passedConcepts.length}/${totalConcepts} 概念</span></h2>
    <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
    <div class="progress-labels"><span>${nodeDone} 节点完成</span><span>${progressPct}%</span></div>
  </div>

  <div class="card">
    <h2>🔔 复习队列 <span class="count">${dueConcepts.length} 个到期</span></h2>
    ${dueItems}
  </div>

  <div class="card">
    <h2>🗺 大纲导航</h2>
    <table>
      <thead><tr><th>节点</th><th>概念进度</th><th>状态</th></tr></thead>
      <tbody>${outlineRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>📖 概念清单 <span class="count">${totalConcepts} 个</span></h2>
    <table>
      <thead><tr><th>节点</th><th>概念</th><th>状态</th><th>均分</th><th>复习阶段</th><th>下次复习</th></tr></thead>
      <tbody>${conceptRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>📊 学习统计</h2>
    <div class="stat-grid">
      <div class="stat"><div class="num">${avgScore}</div><div class="lbl">概念平均分</div></div>
      <div class="stat"><div class="num">${passCount}/${scores.length}</div><div class="lbl">评分通过</div></div>
      <div class="stat"><div class="num">${remediatingConcepts.length}</div><div class="lbl">补救中概念</div></div>
      <div class="stat"><div class="num">${dueConcepts.length}</div><div class="lbl">今日待复习</div></div>
    </div>
  </div>

  <div class="footer">由 feynman_build_site 自动生成 · ${escHtml(now)}</div>
</div>
</body>
</html>`;

	const sitePath = join(siteDir, "index.html");
	await writeFile(sitePath, html, "utf8");
	return sitePath;
}

export type { OutlineNodeInfo };
export {
	SITE_CSS,
	escHtml,
	fmtDate,
	parseOutlineNodes,
	readOutline,
	buildSite,
};

export function registerSiteTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "feynman_build_site",
		label: "Build Project Site",
		description:
			"Generate the project's local dashboard website (site/index.html) from progress.json, index.json, and outline.md: progress bar, review queue, outline navigation, concept list with scores, and learning stats. Called automatically after score/review/progress updates.",
		promptSnippet:
			"feynman_build_site: rebuild the project dashboard HTML (site/index.html) from current project data.",
		promptGuidelines: [
			"Call automatically after record_score, record_review, and update_progress.",
			"The site is a projection of project data; never edit site/index.html by hand.",
		],
		parameters: {
			type: "object",
			properties: {
				project: { type: "string" },
			},
			required: ["project"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params: { project: string }) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			try {
				const sitePath = await buildSite(project);
				return {
					content: [{ type: "text", text: `Rebuilt project site at ${sitePath}.` }],
					details: { ok: true, project, site_path: sitePath },
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Failed to build site: ${error?.message || String(error)}` }],
					details: { ok: false, project, reason: "site_build_failed", error: String(error) },
				};
			}
		},
	});
}
