// The requester's own words are the request. tig reads five things out of one
// natural-language answer — the work, the worker AI tool, its model, its
// reasoning level and the TIG reward — and asks only for what it could not read.
// Nothing here proposes a value: a term that is not in the text stays missing
// until the requester names it (P-052 no silent substitution; P-069 the reward
// is the user's own number and never an estimate).
import { claudeEffortLevels, type LocalAiProvider } from "./local-ai.js";
import { statedReward } from "./request-answers.js";

// Reasoning levels as the tools spell them (Codex catalog: low … ultra; Claude
// Code --effort: low … max) with the labels people use for them, in English and
// Korean. "ultracode" is a Claude Code working mode, not an effort level, so it
// is not accepted here. Multi-word labels come first so "extra high" is read
// whole and never as a bare "high".
export const EFFORT_ALIASES: Record<string, string> = {
  "extra high": "xhigh",
  "extra-high": "xhigh",
  "x-high": "xhigh",
  extrahigh: "xhigh",
  xhigh: "xhigh",
  light: "low",
  minimal: "low",
  low: "low",
  낮음: "low",
  medium: "medium",
  mid: "medium",
  보통: "medium",
  중간: "medium",
  high: "high",
  높음: "high",
  max: "max",
  maximum: "max",
  최대: "max",
  ultra: "ultra",
};
export const normalizeEffort = (text: string) =>
  EFFORT_ALIASES[text.trim().toLowerCase()] ?? text.trim();
// Claude Code's alias list is fixed; Codex has no alias list, so its model is
// whatever the requester's own catalog names (readCodexModels) or what they type.
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;
const PROVIDER_WORDS: [RegExp, LocalAiProvider][] = [
  [/\b(?:claude\s*code|claudecode|claude)\b|클로드(?:\s*코드)?/i, "claude"],
  [/\bcodex\b|코덱스/i, "codex"],
];
const EFFORT_WORDS = new RegExp(
  `(?<![A-Za-z가-힣-])(${Object.keys(EFFORT_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![A-Za-z가-힣-])`,
  "iu",
);
// Model names tig can recognise on their own, without a provider next to them:
// Claude Code's aliases and the shapes Codex catalogs use. Anything else is read
// only from the "provider / model / effort" clause.
const KNOWN_MODELS =
  /\b(opus|sonnet|haiku|fable|sol|astra|gpt[-\s]?[a-z0-9][\w.-]*|codex[-\s]?[a-z0-9][\w.-]*|o[1-9](?:[-\w.]*)?)\b/i;
const SEPARATOR = /^[\s/,·|:]+|[\s/,·|:]+$/g;
const REWARD_SPANS = [
  /(?<![\d,.+-])(?:[1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*(?:TIG|티그|포인트)(?![a-zA-Z])/giu,
  /(?:보상(?:은|으로|을)?|reward(?:\s+is)?|(?:TIG|티그|포인트))\s*[:=]?\s*(?:[1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d,.])/giu,
];

export interface RequestTerms {
  provider?: LocalAiProvider;
  model?: string;
  effort?: string;
  reward?: string;
  // The answer with the recognised terms cut out: the work itself. Falls back
  // to the whole answer when cutting would leave nothing to hand off.
  work: string;
}
interface Span {
  start: number;
  end: number;
}
// The work is the answer minus the terms — but only when the terms trail it as
// a clause of their own ("…, claude / opus / high, 300 TIG"). A term inside a
// sentence ("fix add with gpt astra for 1000 TIG") is left where it is: cutting
// it would leave a sentence with holes, and the requester's sentence is the
// request.
const FILLER = /^[\s,·|/:;()（）\-–—]*$/u;
// What may stand right before a trailing clause: a separator, or nothing. A
// single term after a plain word ("… for 1000 TIG") is part of the sentence;
// two or more terms in a row ("… codex gpt-5 high 120 TIG") are a clause even
// without punctuation.
const CLAUSE_BOUNDARY = /[\s,·|/:;()（）\-–—]$/u;
function cut(text: string, spans: Span[]) {
  // Overlapping matches ("보상은 50" and "50 TIG") are one span.
  const merged: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const sorted = merged.sort((a, b) => b.start - a.start);
  let end = text.length;
  let cutSpans = 0;
  for (const s of sorted) {
    if (s.end > end) continue;
    if (!FILLER.test(text.slice(s.end, end))) break;
    end = s.start;
    cutSpans++;
  }
  const before = text.slice(0, end).trimEnd();
  if (
    end === text.length ||
    (cutSpans < 2 && before.length && !CLAUSE_BOUNDARY.test(before))
  )
    return text.trim();
  return before.replace(/[\s,·|/:;\-–—(（]+$/u, "").trim();
}
// Read the terms out of one answer. Every recognised term is reported with the
// span it came from so the work text can be cut exactly there and nowhere else.
export function parseRequestTerms(text: string): RequestTerms {
  const spans: Span[] = [];
  let provider: LocalAiProvider | undefined, providerSpan: Span | undefined;
  for (const [re, p] of PROVIDER_WORDS) {
    const m = re.exec(text);
    if (m && (!providerSpan || m.index < providerSpan.start)) {
      provider = p;
      providerSpan = { start: m.index, end: m.index + m[0].length };
    }
  }
  if (providerSpan) spans.push(providerSpan);
  let effort: string | undefined, effortSpan: Span | undefined;
  const e = EFFORT_WORDS.exec(text);
  if (e) {
    effort = normalizeEffort(e[1]);
    effortSpan = { start: e.index, end: e.index + e[0].length };
    spans.push(effortSpan);
  }
  let model: string | undefined;
  // "claude / opus / high", "codex gpt-5 high": the model is what sits between
  // the tool and the level, when that is one to three plain words.
  if (providerSpan && effortSpan && providerSpan.end <= effortSpan.start) {
    const between = text
      .slice(providerSpan.end, effortSpan.start)
      .replace(SEPARATOR, "");
    const words = between.split(/\s+/).filter(Boolean);
    if (
      words.length >= 1 &&
      words.length <= 3 &&
      /^[A-Za-z0-9][\w.\- ]*$/.test(between) &&
      !REWARD_SPANS.some((re) => new RegExp(re.source, re.flags).test(between))
    ) {
      model = between;
      spans.push({ start: providerSpan.end, end: effortSpan.start });
    }
  }
  if (!model) {
    const m = KNOWN_MODELS.exec(text);
    if (m) {
      model = m[1];
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  const reward = statedReward(text) ?? undefined;
  if (reward)
    for (const re of REWARD_SPANS)
      for (const m of text.matchAll(re))
        spans.push({ start: m.index, end: m.index + m[0].length });
  const work = cut(text, spans);
  return {
    provider,
    model,
    effort,
    reward,
    work: work.length >= 3 ? work : text.trim(),
  };
}
// Whether a level is one the named tool spells. Codex levels come from its
// catalog and are checked against it where one is available; here only Claude
// Code's fixed vocabulary can refuse.
export function effortAllowed(provider: LocalAiProvider, effort: string) {
  return (
    provider !== "claude" ||
    claudeEffortLevels.includes(effort as (typeof claudeEffortLevels)[number])
  );
}
// "claude / opus / high" (or space separated) → the worker AI requirement, for
// the review screen where a whole triple is typed at once. null when the text
// is not one.
export function parseWorkerAi(text: string) {
  const parts = (
    text.includes("/") ? text.split("/") : text.split(/\s+(?=\S+\s*$|\S)/)
  )
    .map((p) => p.trim())
    .filter(Boolean);
  if (!text.includes("/") && parts.length === 4 && /^extra$/i.test(parts[2]))
    parts.splice(2, 2, `${parts[2]} ${parts[3]}`);
  if (parts.length !== 3) return null;
  parts[2] = normalizeEffort(parts[2]);
  const name = parts[0].toLowerCase().replace(/\s+/g, "");
  const provider =
    name === "codex" || name === "코덱스"
      ? "codex"
      : ["claude", "claudecode", "클로드", "클로드코드"].includes(name)
        ? "claude"
        : null;
  const model = parts[1],
    effort = parts[2];
  if (
    !provider ||
    model.length < 1 ||
    model.length > 100 ||
    effort.length < 1 ||
    effort.length > 80 ||
    !effortAllowed(provider, effort)
  )
    return null;
  return { provider, model, effort } as const;
}
export type WorkerAi = NonNullable<ReturnType<typeof parseWorkerAi>>;
