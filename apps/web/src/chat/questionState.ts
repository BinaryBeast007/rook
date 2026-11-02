// The question panel's state: which question shows, and what the user picked or typed for each.
import type { Question, QuestionAnswer } from "@rook/contracts";

export interface Draft {
  readonly selected: readonly string[];
  /** The user's own text; "" when none. */
  readonly text: string;
}

export interface QuestionState {
  readonly index: number;
  /** By question id. */
  readonly drafts: Readonly<Record<string, Draft>>;
}

export type QuestionAction =
  | { readonly type: "pick"; readonly label: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "go"; readonly index: number };

const EMPTY: Draft = { selected: [], text: "" };

export const initialQuestionState: QuestionState = { index: 0, drafts: {} };

export const draftOf = (state: QuestionState, question: Question): Draft =>
  state.drafts[question.id] ?? EMPTY;

/**
 * A single-select question takes one answer: a pick replaces the earlier one and clears the
 * typed text, and typing clears the pick. A multi-select one keeps both.
 */
export function reduceQuestions(
  questions: readonly Question[],
  state: QuestionState,
  action: QuestionAction,
): QuestionState {
  if (action.type === "go")
    return { ...state, index: Math.max(0, Math.min(action.index, questions.length - 1)) };
  const question = questions[state.index];
  if (!question) return state;
  const draft = draftOf(state, question);
  let next: Draft;
  if (action.type === "pick") {
    if (!question.options.some((option) => option.label === action.label)) return state;
    if (!question.multiSelect) next = { selected: [action.label], text: "" };
    else if (draft.selected.includes(action.label))
      next = { ...draft, selected: draft.selected.filter((label) => label !== action.label) };
    // Kept in the question's own order, whatever order the user picked in.
    else
      next = {
        ...draft,
        selected: question.options
          .map((option) => option.label)
          .filter((label) => label === action.label || draft.selected.includes(label)),
      };
  } else {
    if (!question.allowCustom) return state;
    next = {
      selected: question.multiSelect || !action.text.trim() ? draft.selected : [],
      text: action.text,
    };
  }
  return { ...state, drafts: { ...state.drafts, [question.id]: next } };
}

export function isAnswered(question: Question, draft: Draft): boolean {
  return draft.selected.length > 0 || (question.allowCustom && draft.text.trim() !== "");
}

export const canSubmit = (questions: readonly Question[], state: QuestionState): boolean =>
  questions.length > 0 &&
  questions.every((question) => isAnswered(question, draftOf(state, question)));

/** What `desktop.chat.answer` sends, by question id. */
export function questionAnswers(
  questions: readonly Question[],
  state: QuestionState,
): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const draft = draftOf(state, question);
    const text = question.allowCustom ? draft.text.trim() : "";
    answers[question.id] = { selected: draft.selected, text: text || null };
  }
  return answers;
}

/** A single-select pick moves on to the next question by itself. */
export const advancesAfterPick = (questions: readonly Question[], state: QuestionState): boolean =>
  questions[state.index]?.multiSelect === false && state.index < questions.length - 1;

/**
 * What a key does while the panel has focus: 1–9 picks that option (not while typing), Enter
 * submits once every question is answered, or else moves on from an answered question.
 */
export function questionKey(
  questions: readonly Question[],
  state: QuestionState,
  key: string,
  typing: boolean,
): QuestionAction | "submit" | null {
  const question = questions[state.index];
  if (!question) return null;
  if (!typing && /^[1-9]$/.test(key)) {
    const option = question.options[Number(key) - 1];
    return option ? { type: "pick", label: option.label } : null;
  }
  if (key !== "Enter") return null;
  if (canSubmit(questions, state)) return "submit";
  return isAnswered(question, draftOf(state, question)) && state.index < questions.length - 1
    ? { type: "go", index: state.index + 1 }
    : null;
}

/** One answer as a line, e.g. "Apple, Banana, and kiwi". */
export const answerText = (answer: QuestionAnswer | undefined): string =>
  [...(answer?.selected ?? []), ...(answer?.text ? [answer.text] : [])].join(", ");
