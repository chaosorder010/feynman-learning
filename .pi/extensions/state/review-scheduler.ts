// Spaced-repetition review cadence: 1 day -> 3 days -> 1 week -> 1 month (then graduate).
const REVIEW_CADENCE_DAYS = [1, 3, 7, 30];
const REVIEW_GRADUATED_STAGE = REVIEW_CADENCE_DAYS.length; // stage 4 = graduated, no more reviews
const DEFAULT_REVIEW_STAGE = 0;

// Spaced-repetition schedule for one concept.
// stage 0: learned, next review in 1 day
// stage 1: reviewed, next review in 3 days
// stage 2: reviewed, next review in 1 week
// stage 3: reviewed, next review in 1 month
// stage 4 (REVIEW_GRADUATED_STAGE): graduated, no further scheduled reviews
type ReviewSchedule = {
	stage: number;
	next_review_at: string;
	last_reviewed_at?: string;
};

function addDays(iso: string, days: number): string {
	const d = new Date(iso);
	d.setDate(d.getDate() + days);
	return d.toISOString();
}

function isReviewDue(schedule: ReviewSchedule | undefined, nowIso: string): boolean {
	if (!schedule) return false;
	if (schedule.stage >= REVIEW_GRADUATED_STAGE) return false;
	return schedule.next_review_at <= nowIso;
}

function nextReviewStage(schedule: ReviewSchedule | undefined): number {
	if (!schedule) return DEFAULT_REVIEW_STAGE;
	return Math.min(schedule.stage + 1, REVIEW_GRADUATED_STAGE);
}

function daysOverdue(schedule: ReviewSchedule | undefined, nowIso: string): number {
	if (!schedule || !isReviewDue(schedule, nowIso)) return 0;
	const ms = new Date(nowIso).getTime() - new Date(schedule.next_review_at).getTime();
	return Math.max(0, Math.floor(ms / 86_400_000));
}

function newReviewSchedule(nowIso: string): ReviewSchedule {
	return {
		stage: DEFAULT_REVIEW_STAGE,
		next_review_at: addDays(nowIso, REVIEW_CADENCE_DAYS[DEFAULT_REVIEW_STAGE]),
	};
}

function advanceReviewSchedule(schedule: ReviewSchedule | undefined, nowIso: string): ReviewSchedule {
	const stage = nextReviewStage(schedule);
	return {
		stage,
		next_review_at:
			stage >= REVIEW_GRADUATED_STAGE ? "" : addDays(nowIso, REVIEW_CADENCE_DAYS[stage]),
		last_reviewed_at: nowIso,
	};
}

export type { ReviewSchedule };
export {
	REVIEW_CADENCE_DAYS,
	REVIEW_GRADUATED_STAGE,
	DEFAULT_REVIEW_STAGE,
	addDays,
	isReviewDue,
	nextReviewStage,
	daysOverdue,
	newReviewSchedule,
	advanceReviewSchedule,
};
