import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { slugify, nowStamp } from "./util.js";
import type { BranchMode } from "./util.js";

type ConceptNoteParams = {
	project: string;
	outlineNode: string;
	concept: string;
	state?: string;
	learningGoal?: string;
	intuitiveExplanation?: string;
	preciseDefinition?: string;
	mechanismSteps?: string[];
	minimalExample?: string;
	misconceptions?: string[];
	relationToNeighborConcepts?: string;
	restatementTask?: string;
	checkQuestions?: string[];
	learnerOutputAndCorrections?: string;
	force?: boolean;
	branchMode?: BranchMode;
};

const MIN_RESTATEMENT_CHARS = 20;

const conceptNoteParameters = {
	type: "object",
	properties: {
		project: { type: "string" },
		outlineNode: { type: "string" },
		concept: { type: "string" },
		state: { type: "string" },
		learningGoal: { type: "string" },
		intuitiveExplanation: { type: "string" },
		preciseDefinition: { type: "string" },
		mechanismSteps: { type: "array", items: { type: "string" } },
		minimalExample: { type: "string" },
		misconceptions: { type: "array", items: { type: "string" } },
		relationToNeighborConcepts: { type: "string" },
		restatementTask: { type: "string" },
		checkQuestions: { type: "array", items: { type: "string" } },
		learnerOutputAndCorrections: { type: "string" },
		force: {
			type: "boolean",
			description:
				"Set to true to bypass the same-node remediating-blocker check. Use only when the learner explicitly asks to skip the unfinished concept.",
		},
		branchMode: {
			type: "string",
			description:
				"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.",
		},
	},
	required: ["project", "outlineNode", "concept"],
	additionalProperties: false,
} as any;

async function walkConceptNoteFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const out: string[] = [];
	for (const dirent of entries) {
		if (dirent.name === "index.json") continue;
		const full = join(dir, dirent.name);
		if (dirent.isDirectory()) {
			out.push(...(await walkConceptNoteFiles(full)));
		} else if (dirent.isFile() && dirent.name.endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

function parseConceptHeader(markdown: string): { concept?: string; outline_node?: string } {
	const lines = markdown.split("\n").slice(0, 30);
	const result: { concept?: string; outline_node?: string } = {};
	for (const line of lines) {
		if (!result.concept && line.startsWith("# ")) {
			result.concept = line.slice(2).trim();
		}
		const m = line.match(/^-\s*Outline node:\s*(.+)$/i);
		if (m && !result.outline_node) {
			result.outline_node = m[1].trim();
		}
		if (result.concept && result.outline_node) break;
	}
	return result;
}

function deriveSlugsFromPath(filePath: string, baseDir: string): { nodeSlug: string; conceptSlug: string } {
	const rel = relative(baseDir, filePath);
	const parts = rel.split(/[\\/]/);
	const last = parts[parts.length - 1] || "concept.md";
	const conceptSlug = basename(last, ".md") || "concept";
	const nodeSlug = parts.length >= 2 ? parts[parts.length - 2] : "outline-node";
	return { nodeSlug, conceptSlug };
}

function listLines(values: string[] | undefined): string {
	const clean = (values || []).map((value) => value.trim()).filter(Boolean);
	if (clean.length === 0) return "- TODO";
	return clean.map((value) => `- ${value}`).join("\n");
}

function text(value: string | undefined): string {
	return value?.trim() || "TODO";
}

function renderConceptNote(params: ConceptNoteParams, notePath: string): string {
	const state = params.state || "WAITING_RESTATEMENT";
	return [
		`# ${params.concept}`,
		"",
		`- Project: ${slugify(params.project)}`,
		`- Outline node: ${params.outlineNode}`,
		`- State: ${state}`,
		`- Date: ${nowStamp().slice(0, 10)}`,
		`- Path: ${notePath}`,
		"",
		"## Learning Goal",
		"",
		text(params.learningGoal),
		"",
		"## Intuitive Explanation",
		"",
		text(params.intuitiveExplanation),
		"",
		"## Precise Definition And Boundaries",
		"",
		text(params.preciseDefinition),
		"",
		"## Mechanism Steps",
		"",
		listLines(params.mechanismSteps),
		"",
		"## Minimal Example",
		"",
		text(params.minimalExample),
		"",
		"## Counterexamples And Misconceptions",
		"",
		listLines(params.misconceptions),
		"",
		"## Relation To Neighbor Concepts",
		"",
		text(params.relationToNeighborConcepts),
		"",
		"## Feynman Restatement Task",
		"",
		text(params.restatementTask),
		"",
		"## Check Questions",
		"",
		listLines(params.checkQuestions),
		"",
		"## Learner Output And Corrections",
		"",
		text(params.learnerOutputAndCorrections),
		"",
	].join("\n");
}

function appendCorrection(existing: string, params: ConceptNoteParams): string {
	const update = params.learnerOutputAndCorrections?.trim();
	if (!update) return existing;

	return [
		existing.trimEnd(),
		"",
		`### Update ${nowStamp()}`,
		"",
		update,
		"",
	].join("\n");
}

export type { ConceptNoteParams };
export {
	conceptNoteParameters,
	MIN_RESTATEMENT_CHARS,
	walkConceptNoteFiles,
	parseConceptHeader,
	deriveSlugsFromPath,
	renderConceptNote,
	appendCorrection,
	listLines,
	text,
};
