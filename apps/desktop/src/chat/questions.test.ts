import { expect, test } from "vite-plus/test";

import {
  claudeAnswers,
  claudeDecline,
  claudeQuestions,
  claudeReply,
  codexAnswers,
  codexQuestions,
} from "./questions.ts";

const CLAUDE_INPUT = {
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      multiSelect: false,
      options: [{ label: "Red", description: "Warm" }, { label: "Blue" }, { description: "x" }],
    },
    { question: "Which colour?", multiSelect: true, options: [] },
    { header: "No text" },
    "junk",
  ],
};

test("claudeQuestions keys by question text, suffixing repeats, and skips junk", () => {
  expect(claudeQuestions(CLAUDE_INPUT)).toEqual([
    {
      id: "Which colour?",
      header: "Colour",
      question: "Which colour?",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Blue", description: null },
      ],
      multiSelect: false,
      allowCustom: true,
    },
    {
      id: "Which colour? (2)",
      header: null,
      question: "Which colour?",
      options: [],
      multiSelect: true,
      allowCustom: true,
    },
  ]);
  expect(claudeQuestions({})).toEqual([]);
});

test("claudeAnswers joins labels with the user's text last, keyed by question text", () => {
  const input = {
    questions: [
      { question: "A?", options: [{ label: "x" }, { label: "y" }], multiSelect: true },
      { question: "B?", options: [{ label: "z" }] },
      { question: "C?", options: [] },
    ],
  };
  const questions = claudeQuestions(input);
  expect(
    claudeAnswers(input, questions, {
      "A?": { selected: ["x", "y"], text: null },
      "B?": { selected: ["z"], text: "but small" },
      "C?": { selected: [], text: "free, text" },
    }),
  ).toEqual({ ...input, answers: { "A?": "x, y", "B?": "z, but small", "C?": "free, text" } });
});

test("claudeReply allows with answers, or denies with the feedback", () => {
  const input = { questions: [{ question: "A?", options: [{ label: "x" }] }] };
  const questions = claudeQuestions(input);
  expect(
    claudeReply(input, questions, { answers: { "A?": { selected: ["x"], text: null } } }),
  ).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "A?": "x" } } });
  expect(claudeReply(input, questions, { declined: true, feedback: "No" })).toEqual({
    behavior: "deny",
    message: "The user declined to answer your questions and said: No",
  });
  expect(claudeDecline(null)).toBe("The user declined to answer your questions.");
});

test("codexQuestions maps isOther, and options: null to a free-text question", () => {
  expect(
    codexQuestions({
      questions: [
        {
          id: "colour",
          header: "Colour",
          question: "Which colour?",
          isOther: false,
          options: [{ label: "Red", description: "" }],
        },
        { id: "other", header: "", question: "Or?", isOther: true, options: [{ label: "A" }] },
        { id: "name", header: "Name", question: "Its name?", isOther: false, options: null },
        { header: "no id" },
      ],
    }),
  ).toEqual([
    {
      id: "colour",
      header: "Colour",
      question: "Which colour?",
      options: [{ label: "Red", description: null }],
      multiSelect: false,
      allowCustom: false,
    },
    {
      id: "other",
      header: null,
      question: "Or?",
      options: [{ label: "A", description: null }],
      multiSelect: false,
      allowCustom: true,
    },
    {
      id: "name",
      header: "Name",
      question: "Its name?",
      options: [],
      multiSelect: false,
      allowCustom: true,
    },
  ]);
});

test("codexAnswers sends labels then text, and a decline answers every question", () => {
  const questions = codexQuestions({
    questions: [
      { id: "a", question: "A?", options: [{ label: "x" }], isOther: true },
      { id: "b", question: "B?", options: null },
    ],
  });
  expect(
    codexAnswers(questions, {
      answers: { a: { selected: ["x"], text: "and y" }, b: { selected: [], text: "free" } },
    }),
  ).toEqual({ answers: { a: { answers: ["x", "and y"] }, b: { answers: ["free"] } } });
  expect(codexAnswers(questions, { declined: true, feedback: null })).toEqual({
    answers: {
      a: { answers: ["The user declined to answer."] },
      b: { answers: ["The user declined to answer."] },
    },
  });
  expect(codexAnswers(questions, { declined: true, feedback: "busy" }).answers.a).toEqual({
    answers: ["The user declined to answer: busy"],
  });
});

test("claudeAnswers keeps both answers when two questions share their text", () => {
  const input = { questions: [{ question: "Which colour?" }, { question: "Which colour?" }] };
  const questions = claudeQuestions(input);
  const answers = Object.fromEntries(
    questions.map((question, i) => [question.id, { selected: [], text: i ? "blue" : "red" }]),
  );
  expect(claudeAnswers(input, questions, answers).answers).toEqual({
    "Which colour?": "red; blue",
  });
});
