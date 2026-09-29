import { taskSpec } from "../../../packages/contracts/src/index.js";
import type { Terminal } from "./terminal.js";

const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!?。]+$/u, "")
    .trim();
export function confirmationAnswer(text: string): boolean | null {
  const value = normalize(text);
  if (
    [
      "yes",
      "y",
      "네",
      "예",
      "응",
      "좋아",
      "좋아요",
      "동의",
      "동의해",
      "진행해",
      "진행해주세요",
      "네 진행해주세요",
      "네 그렇게 해주세요",
    ].includes(value)
  )
    return true;
  if (
    [
      "no",
      "n",
      "아니",
      "아니요",
      "아니오",
      "안 돼",
      "안돼",
      "하지마",
      "하지 마",
      "취소",
    ].includes(value)
  )
    return false;
  return null;
}
export function choiceAnswer(text: string, choices: string[]): number | null {
  const value = normalize(text);
  if (/^[1-9]\d*$/.test(value)) {
    const index = Number(value) - 1;
    return index < choices.length ? index : null;
  }
  const exact = choices.findIndex((choice) => normalize(choice) === value);
  if (exact >= 0) return exact;
  const aliases: [string[], RegExp][] = [
    [["코덱스"], /^Codex$/],
    [["클로드", "클로드 코드", "claude"], /^Claude Code$/],
    [["보기", "읽기", "명세 보기", "확인"], /^Read the generated request/],
    [["저장", "저장하고 종료", "나중에"], /^Save and exit/],
    [["재시도", "다시"], /^Retry this request/],
    [["새 저장소", "새로 만들기"], /^Create a separate public/],
    [["기존 저장소"], /^Use an existing public/],
    [
      ["publish", "upload", "올려줘", "업로드", "게시", "올려주세요"],
      /^Publish publicly/,
    ],
  ];
  for (const [answers, pattern] of aliases)
    if (answers.includes(value)) {
      const index = choices.findIndex((choice) => pattern.test(choice));
      if (index >= 0) return index;
    }
  if (confirmationAnswer(value) === true) {
    const index = choices.findIndex((choice) =>
      /^Publish publicly|^Continue with these files/.test(choice),
    );
    if (index >= 0) return index;
  }
  if (
    confirmationAnswer(value) === false &&
    choices.some((choice) => /^Publish publicly/.test(choice))
  ) {
    const index = choices.findIndex((choice) => /^Save and exit/.test(choice));
    if (index >= 0) return index;
  }
  return null;
}

// Payment terms come only from the current user's text or an explicit reward answer.
// AI output, repository content and saved handoff text cannot supply a reward.
const number = String.raw`(?:[1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
const unit = String.raw`(?:TIG|티그|포인트)`;
export function statedReward(text: string, standalone = false): string | null {
  const values: string[] = [];
  if (standalone && new RegExp(`^\\s*${number}\\s*$`, "u").test(text))
    values.push(text.trim());
  for (const expression of [
    new RegExp(`(?<![\\d,.+-])(${number})\\s*${unit}(?![a-zA-Z])`, "giu"),
    new RegExp(
      `(?:보상(?:은|으로|을)?|reward(?:\\s+is)?|${unit})\\s*[:=]?\\s*(${number})(?![\\d,.])`,
      "giu",
    ),
  ])
    for (const match of text.matchAll(expression)) values.push(match[1]);
  const valid = [...new Set(values.map((value) => value.replaceAll(",", "")))];
  // Multiple or negated/corrected amounts require an explicit answer instead of guessing.
  if (valid.length !== 1 || /(?:아니|말고|not\b|instead\b|\?)/iu.test(text))
    return null;
  return taskSpec.shape.rewardTig.safeParse(valid[0]).success ? valid[0] : null;
}
export async function collectReward(
  request: string,
  ui: Terminal,
  // The requester's own previous amount, offered as the Enter default. Never an
  // AI-invented figure: with no previous amount the question has no default.
  previous?: string,
): Promise<string> {
  let reward = statedReward(request);
  while (!reward) {
    const answer = await ui.ask(
      previous
        ? `How much TIG would you like to offer? (Enter = ${previous} TIG, your previous amount)`
        : "How much TIG would you like to offer? (e.g. 100 TIG / 100 티그)",
      previous,
    );
    reward = statedReward(answer, true);
    if (!reward)
      ui.say(
        "Enter one positive TIG amount. No reward is selected automatically.",
      );
  }
  ui.say(`Reward: ${reward} TIG · reserved only when you publish`);
  return reward;
}
