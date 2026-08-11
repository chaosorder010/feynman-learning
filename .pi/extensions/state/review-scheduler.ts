import { createEmptyCard, fsrs, Rating, State } from "ts-fsrs";
import type { Card } from "ts-fsrs";
import { daysBetween } from "./util.js";

// Legacy fixed cadence, retained only for backfilling pre-FSRS schedules and
// for dashboard continuity with older progress data.
const REVIEW_CADENCE_DAYS = [1, 3, 7, 30];
const DEFAULT_GRADUATION_STABILITY_DAYS = 100;

// FSRS scheduler with default parameters. Shared singleton - created once per
// process. The rubric score (5-dimension average) is the single source of truth
// for both pass/fail and the FSRS rating; no second grading channel is used.
const scheduler = fsrs();

// Spaced-repetition schedule for one concept. The FSRS fields (stability,
// difficulty, retrievability, last_rating, state, reps, lapses) are additive
// over the legacy { stage, next_review_at, last_reviewed_at } shape. The legacy
// `stage` field is retained on disk so older progress data still loads.
type ReviewSchedule = {
	stage?: number;
	stability?: number;
	difficulty?: number;
	retrievability?: number;
	last_rating?: Rating;
	state?: "learning" | "review" | "relearning" | "graduated";
	reps?: number;
	lapses?: number;
	next_review_at: string;
	last_reviewed_at?: string;
};

function addDays(iso: string, days: number): string {
	const d = new Date(iso);
	d.setDate(d.getDate() + days);
	return d.toISOString();
}

// Map the 5-dimension rubric average to an FSRS rating. This is the only place
// a rating is derived - record_score and record_review both feed the rubric
// average through this function, so the rubric stays the single source of truth.
function scoreToRating(average: number): Rating {
	if (average >= 9) return Rating.Easy;
	if (average >= 7) return Rating.Good;
	if (average >= 6) return Rating.Hard;
	return Rating.Again;
}

// ts-fsrs State <-> serialized string lookup tables (single source per direction).
const STATE_TO_STRING: Record<State, ReviewSchedule["state"]> = {
	[State.Review]: "review",
	[State.Relearning]: "relearning",
	[State.Learning]: "learning",
	[State.New]: "learning",
};

const STRING_TO_STATE: Record<string, State> = {
	review: State.Review,
	relearning: State.Relearning,
	learning: State.Learning,
	graduated: State.Learning,
};

function tsrsStateToString(state: State): ReviewSchedule["state"] {
	return STATE_TO_STRING[state];
}

function stringToTsrsState(state: ReviewSchedule["state"] | undefined): State {
	return STRING_TO_STATE[state ?? "learning"] ?? State.Learning;
}

function toDate(value: Date | string | number): Date {
	return value instanceof Date ? value : new Date(value);
}

function cardToSchedule(card: Card, rating: Rating | undefined, nowIso: string): ReviewSchedule {
	const due = toDate(card.due);
	const lastReview = card.last_review ? toDate(card.last_review) : undefined;
	let retrievability: number | undefined;
	try {
		retrievability = scheduler.get_retrievability(card, new Date(nowIso), false);
	} catch {
		retrievability = undefined;
	}
	return {
		stability: card.stability,
		difficulty: card.difficulty,
		retrievability,
		last_rating: rating,
		state: tsrsStateToString(card.state),
		reps: card.reps,
		lapses: card.lapses,
		next_review_at: due.toISOString(),
		last_reviewed_at: lastReview ? lastReview.toISOString() : nowIso,
	};
}

function scheduleToCard(schedule: ReviewSchedule | undefined, nowIso: string): Card {
	if (!schedule) return createEmptyCard();
	const now = new Date(nowIso);
	const lastReview = schedule.last_reviewed_at ? new Date(schedule.last_reviewed_at) : undefined;
	const elapsedDays = lastReview ? daysBetween(now, lastReview) : 0;
	return {
		due: new Date(schedule.next_review_at),
		stability: schedule.stability ?? 0,
		difficulty: schedule.difficulty ?? 0,
		elapsed_days: elapsedDays,
		last_review: lastReview,
		reps: schedule.reps ?? 0,
		lapses: schedule.lapses ?? 0,
		state: stringToTsrsState(schedule.state),
	};
}

// Initialize a schedule on first pass. The rating is derived from the rubric
// average so a high-scoring first pass schedules a longer first interval.
function newReviewSchedule(nowIso: string, rating: Rating = Rating.Good): ReviewSchedule {
	const card = createEmptyCard();
	const result = scheduler.next(card, new Date(nowIso), rating);
	return cardToSchedule(result.card, rating, nowIso);
}

// Advance a schedule by one review. The rating is derived from the rubric so
// recall quality drives interval length. Graduation is decided by a stability
// threshold (configurable per project), not a fixed stage index.
function advanceReviewSchedule(
	schedule: ReviewSchedule | undefined,
	nowIso: string,
	rating: Rating,
	graduationStabilityDays: number = DEFAULT_GRADUATION_STABILITY_DAYS,
): ReviewSchedule {
	const card = scheduleToCard(schedule, nowIso);
	const result = scheduler.next(card, new Date(nowIso), rating);
	const next = cardToSchedule(result.card, rating, nowIso);
	if (next.stability !== undefined && next.stability >= graduationStabilityDays) {
		return { ...next, state: "graduated" };
	}
	return next;
}

function isReviewDue(schedule: ReviewSchedule | undefined, nowIso: string): boolean {
	if (!schedule) return false;
	if (schedule.state === "graduated") return false;
	return schedule.next_review_at <= nowIso;
}

function daysOverdue(schedule: ReviewSchedule | undefined, nowIso: string): number {
	if (!schedule || schedule.state === "graduated" || !isReviewDue(schedule, nowIso)) return 0;
	return daysBetween(nowIso, schedule.next_review_at);
}

function isGraduated(
	schedule: ReviewSchedule | undefined,
	graduationStabilityDays: number = DEFAULT_GRADUATION_STABILITY_DAYS,
): boolean {
	if (!schedule) return false;
	if (schedule.state === "graduated") return true;
	return schedule.stability !== undefined && schedule.stability >= graduationStabilityDays;
}

// Backfill a legacy stage-based schedule into the FSRS shape without rewriting
// disk. stage k -> stability ~= REVIEW_CADENCE_DAYS[k]; graduated stage ->
// state "graduated". Called on read so no learner's existing data needs repair.
function backfillLegacySchedule(
	schedule: ReviewSchedule | undefined,
	nowIso: string,
): ReviewSchedule | undefined {
	if (!schedule) return schedule;
	if (schedule.stability !== undefined) return schedule;
	const stage = schedule.stage ?? 0;
	const cadence = REVIEW_CADENCE_DAYS;
	if (stage >= cadence.length) {
		return {
			...schedule,
			stability: cadence[cadence.length - 1],
			difficulty: 0,
			state: "graduated",
			next_review_at: schedule.next_review_at || nowIso,
		};
	}
	const stability = cadence[stage];
	const lastReview = schedule.last_reviewed_at || nowIso;
	const nextReview = addDays(lastReview, stability);
	return {
		...schedule,
		stability,
		difficulty: 0,
		state: "review",
		next_review_at: nextReview,
	};
}

// Legacy graduation stage index, used only by the dashboard legend.
const REVIEW_GRADUATED_STAGE = REVIEW_CADENCE_DAYS.length;

export type { ReviewSchedule };
export {
	REVIEW_CADENCE_DAYS,
	REVIEW_GRADUATED_STAGE,
	DEFAULT_GRADUATION_STABILITY_DAYS,
	Rating,
	addDays,
	scoreToRating,
	isReviewDue,
	daysOverdue,
	newReviewSchedule,
	advanceReviewSchedule,
	isGraduated,
	backfillLegacySchedule,
};
