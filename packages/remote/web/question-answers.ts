import type { Question } from "../src/protocol.ts";

/** `closed`: the Claude app answered this approval first; the host's sentence is shown, muted, and nothing more is sent. */
export interface QuestionDraft { current: number; selected: Record<string, string[]>; free: Record<string, string>; sending?: boolean; unconfirmed?: boolean; error?: string; closed?: string }
export const emptyQuestionDraft = (): QuestionDraft => ({ current: 0, selected: {}, free: {} });

export function toggleOption(draft: QuestionDraft, question: Question, index: number): QuestionDraft {
  const option = question.options[index];
  if (!option) return draft;
  const previous = draft.selected[question.question] ?? [];
  const selected = question.multiSelect ? previous.includes(option.label) ? previous.filter(label => label !== option.label) : [...previous, option.label] : [option.label];
  return { ...draft, selected: { ...draft.selected, [question.question]: selected }, free: question.multiSelect ? draft.free : { ...draft.free, [question.question]: "" } };
}
export function freeAnswer(draft: QuestionDraft, question: Question, text: string): QuestionDraft {
  return { ...draft, free: { ...draft.free, [question.question]: text }, selected: question.multiSelect ? draft.selected : { ...draft.selected, [question.question]: [] } };
}
/** The SDK contract is one string per exact question text; multiple answers are joined with comma+space. */
export function questionAnswers(questions: readonly Question[], draft: QuestionDraft): Record<string, string> {
  return Object.fromEntries(questions.map(question => {
    const selected = (draft.selected[question.question] ?? []).filter(label => question.options.some(option => option.label === label));
    const choices = question.multiSelect ? selected : selected.slice(0, 1);
    const free = draft.free[question.question] ?? "";
    return [question.question, [...choices, ...(free.trim() ? [free] : [])].join(", ")];
  }));
}
export function questionsComplete(questions: readonly Question[], draft: QuestionDraft): boolean {
  const answers = questionAnswers(questions, draft);
  return questions.length > 0 && questions.every(question => !!answers[question.question]);
}
