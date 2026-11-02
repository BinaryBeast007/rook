// Agent questions to and from Rook's `Question` parts: Claude Code's AskUserQuestion tool and
// Codex's item/tool/requestUserInput request.
import type { Question, QuestionAnswer } from "@rook/contracts";

import type { QuestionReply } from "./runtime.ts";

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function options(value: unknown): Question["options"] {
  return list(value)
    .map(object)
    .flatMap((option) => {
      const label = str(option?.label);
      return label ? [{ label, description: str(option?.description) || null }] : [];
    });
}

/** Picked labels, then the user's own text. */
const parts = (answer: QuestionAnswer | undefined) => [
  ...(answer?.selected ?? []),
  ...(answer?.text ? [answer.text] : []),
];

/**
 * AskUserQuestion's questions. Claude gives them no ids and keys answers by question text, so the
 * text is the id (a repeat gets a suffix so ids stay unique).
 */
export function claudeQuestions(input: Json): Question[] {
  const seen = new Set<string>();
  return list(input.questions)
    .map(object)
    .flatMap((question) => {
      const text = str(question?.question);
      if (!text) return [];
      let id = text;
      for (let n = 2; seen.has(id); n++) id = `${text} (${n})`;
      seen.add(id);
      return [
        {
          id,
          header: str(question?.header) || null,
          question: text,
          options: options(question?.options),
          multiSelect: question?.multiSelect === true,
          allowCustom: true,
        },
      ];
    });
}

/**
 * The AskUserQuestion input to allow the call with: answers by question text, labels joined with
 * ", " and the user's own text last, as Claude Code's own UI sends them.
 */
export function claudeAnswers(
  input: Json,
  questions: readonly Question[],
  answers: Readonly<Record<string, QuestionAnswer>>,
): Json {
  const byText: Record<string, string> = {};
  for (const question of questions) {
    const answer = parts(answers[question.id]).join(", ");
    // Repeated question text shares one key: keep every answer.
    const earlier = byText[question.question];
    byText[question.question] = earlier === undefined ? answer : `${earlier}; ${answer}`;
  }
  return { ...input, answers: byText };
}

/** What Claude hears when the user declines its questions. */
export function claudeDecline(feedback: string | null): string {
  return feedback
    ? `The user declined to answer your questions and said: ${feedback}`
    : "The user declined to answer your questions.";
}

/** The control response for AskUserQuestion: allow with the answers, or deny on decline. */
export function claudeReply(input: Json, questions: readonly Question[], reply: QuestionReply) {
  return "answers" in reply
    ? { behavior: "allow", updatedInput: claudeAnswers(input, questions, reply.answers) }
    : { behavior: "deny", message: claudeDecline(reply.feedback) };
}

/** requestUserInput's questions. `options: null` is a free-text question. */
export function codexQuestions(params: Json): Question[] {
  return list(params.questions)
    .map(object)
    .flatMap((question) => {
      const id = str(question?.id);
      if (!id) return [];
      const choices = options(question?.options);
      return [
        {
          id,
          header: str(question?.header) || null,
          question: str(question?.question) ?? "",
          options: choices,
          multiSelect: false,
          allowCustom: question?.isOther === true || !choices.length,
        },
      ];
    });
}

/**
 * The requestUserInput result. Codex has no decline, so a decline answers every question with a
 * note saying so; an empty `answers` would read as "skipped" to the model.
 */
export function codexAnswers(questions: readonly Question[], reply: QuestionReply) {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions)
    answers[question.id] = {
      answers:
        "answers" in reply
          ? parts(reply.answers[question.id])
          : [`The user declined to answer${reply.feedback ? `: ${reply.feedback}` : "."}`],
    };
  return { answers };
}
