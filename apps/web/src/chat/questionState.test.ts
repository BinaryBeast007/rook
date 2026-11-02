import type { Question } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  advancesAfterPick,
  answerText,
  canSubmit,
  initialQuestionState,
  questionAnswers,
  questionKey,
  reduceQuestions,
  type QuestionAction,
  type QuestionState,
} from "./questionState.ts";

const option = (label: string) => ({ label, description: null });
const QUESTIONS: Question[] = [
  {
    id: "colour",
    header: "Colour",
    question: "Which colour?",
    options: [option("Red"), option("Blue")],
    multiSelect: false,
    allowCustom: true,
  },
  {
    id: "fruit",
    header: null,
    question: "Which fruits?",
    options: [option("Apple"), option("Banana"), option("Cherry")],
    multiSelect: true,
    allowCustom: false,
  },
];

const run = (...actions: QuestionAction[]): QuestionState =>
  actions.reduce(
    (state, action) => reduceQuestions(QUESTIONS, state, action),
    initialQuestionState,
  );

test("a single-select pick replaces the earlier pick and the typed text", () => {
  const state = run(
    { type: "text", text: "Green" },
    { type: "pick", label: "Red" },
    {
      type: "pick",
      label: "Blue",
    },
  );
  expect(state.drafts.colour).toEqual({ selected: ["Blue"], text: "" });
});

test("typing in a single-select question clears its pick; blank text keeps it", () => {
  expect(run({ type: "pick", label: "Red" }, { type: "text", text: "  " }).drafts.colour).toEqual({
    selected: ["Red"],
    text: "  ",
  });
  expect(run({ type: "pick", label: "Red" }, { type: "text", text: "Teal" }).drafts.colour).toEqual(
    { selected: [], text: "Teal" },
  );
});

test("multi-select toggles, keeping the question's option order", () => {
  const state = run(
    { type: "go", index: 1 },
    { type: "pick", label: "Cherry" },
    { type: "pick", label: "Apple" },
    { type: "pick", label: "Banana" },
    { type: "pick", label: "Cherry" },
  );
  expect(state.drafts.fruit?.selected).toEqual(["Apple", "Banana"]);
});

test("unknown labels and text without allowCustom are ignored", () => {
  expect(run({ type: "pick", label: "Purple" })).toEqual(initialQuestionState);
  expect(run({ type: "go", index: 1 }, { type: "text", text: "Kiwi" }).drafts).toEqual({});
});

test("go stays within the questions", () => {
  expect(run({ type: "go", index: 5 }).index).toBe(1);
  expect(run({ type: "go", index: -1 }).index).toBe(0);
});

test("submits only once every question is answered, with trimmed text or null", () => {
  const partial = run({ type: "text", text: " Teal " });
  expect(canSubmit(QUESTIONS, partial)).toBe(false);
  const full = reduceQuestions(
    QUESTIONS,
    reduceQuestions(QUESTIONS, partial, { type: "go", index: 1 }),
    { type: "pick", label: "Banana" },
  );
  expect(canSubmit(QUESTIONS, full)).toBe(true);
  expect(questionAnswers(QUESTIONS, full)).toEqual({
    colour: { selected: [], text: "Teal" },
    fruit: { selected: ["Banana"], text: null },
  });
  expect(canSubmit([], initialQuestionState)).toBe(false);
});

test("only a single-select pick before the last question advances", () => {
  expect(advancesAfterPick(QUESTIONS, initialQuestionState)).toBe(true);
  expect(advancesAfterPick(QUESTIONS, run({ type: "go", index: 1 }))).toBe(false);
  expect(advancesAfterPick([QUESTIONS[0]!], initialQuestionState)).toBe(false);
});

test("keys 1–9 pick, not while typing; Enter moves on, then submits", () => {
  const start = initialQuestionState;
  expect(questionKey(QUESTIONS, start, "2", false)).toEqual({ type: "pick", label: "Blue" });
  expect(questionKey(QUESTIONS, start, "3", false)).toBeNull();
  expect(questionKey(QUESTIONS, start, "1", true)).toBeNull();
  expect(questionKey(QUESTIONS, start, "Enter", false)).toBeNull();
  const picked = run({ type: "pick", label: "Red" });
  expect(questionKey(QUESTIONS, picked, "Enter", true)).toEqual({ type: "go", index: 1 });
  const last = reduceQuestions(
    QUESTIONS,
    reduceQuestions(QUESTIONS, picked, { type: "go", index: 1 }),
    { type: "pick", label: "Apple" },
  );
  expect(questionKey(QUESTIONS, last, "Enter", false)).toBe("submit");
  expect(questionKey(QUESTIONS, last, "a", false)).toBeNull();
});

test("answerText puts picks first, then the user's text", () => {
  expect(answerText({ selected: ["Apple", "Banana"], text: "and kiwi" })).toBe(
    "Apple, Banana, and kiwi",
  );
  expect(answerText(undefined)).toBe("");
});
