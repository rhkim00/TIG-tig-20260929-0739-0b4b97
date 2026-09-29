import { createInterface, type Interface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { choiceAnswer, confirmationAnswer } from "./request-answers.js";

// Project names, model output and server errors are untrusted terminal content.
export function terminalText(value: string) {
  return stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}
export class Cancelled extends Error {
  constructor() {
    super("Stopped. Any saved draft is kept for next time.");
  }
}
export interface Terminal {
  say(message: string): void;
  section(step: string, title: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  // fallback: index used when the user just presses Enter; null forces an explicit choice.
  choose(
    question: string,
    choices: string[],
    fallback?: number | null,
  ): Promise<number>;
  // fallback: the answer taken when the user just presses Enter ("no" unless stated).
  confirm(question: string, fallback?: "yes" | "no"): Promise<boolean>;
  busy<T>(label: string, run: () => Promise<T>): Promise<T>;
}
export class RequestTerminal implements Terminal {
  private rl: Interface;
  private controller = new AbortController();
  private color =
    !!process.stdout.isTTY &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("SIGINT", () => {
      this.controller.abort();
      this.rl.close();
    });
    this.rl.on("close", () => this.controller.abort());
  }
  get signal() {
    return this.controller.signal;
  }
  private ink(code: number, text: string) {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
  say(message: string) {
    process.stdout.write(
      "  " + terminalText(message).replaceAll("\n", "\n  ") + "\n",
    );
  }
  section(step: string, title: string) {
    process.stdout.write(
      `\n  ${this.ink(33, "◆")} ${this.ink(1, terminalText(title))}  ${this.ink(90, terminalText(step))}\n\n`,
    );
  }
  async ask(question: string, fallback?: string): Promise<string> {
    if (this.signal.aborted) throw new Cancelled();
    try {
      const value = (
        await this.rl.question(
          `  ${this.ink(36, "›")} ${terminalText(question)}${fallback ? this.ink(90, ` [${terminalText(fallback)}]`) : ""}\n  ${this.ink(33, "❯")} `,
          { signal: this.signal },
        )
      ).trim();
      if (value === "/cancel") throw new Cancelled();
      return value || fallback || "";
    } catch {
      throw new Cancelled();
    }
  }
  async choose(
    question: string,
    choices: string[],
    fallback: number | null = 0,
  ) {
    this.say(question);
    choices.forEach((v, i) => this.say(`${i + 1}  ${v}`));
    while (true) {
      const answer = await this.ask(
        "Choose",
        fallback === null ? undefined : String(fallback + 1),
      );
      const index = choiceAnswer(answer, choices);
      if (index !== null) return index;
      this.say(
        `Enter a number from 1 to ${choices.length}, or the choice in English or Korean.`,
      );
    }
  }
  async confirm(question: string, fallback: "yes" | "no" = "no") {
    while (true) {
      const answer = (
        await this.ask(`${question} (yes/no)`, fallback)
      ).toLowerCase();
      const decision = confirmationAnswer(answer);
      if (decision !== null) return decision;
      this.say("Please enter yes/no or 네/아니요.");
    }
  }
  async busy<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw new Cancelled();
    const start = Date.now(),
      frames = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    this.say(label);
    const timer = this.color
      ? setInterval(() => {
          process.stdout.write(
            `\r  ${this.ink(33, frames[frame++ % frames.length])} ${terminalText(label)} · ${Math.floor((Date.now() - start) / 1000)}s\x1b[K`,
          );
        }, 120)
      : undefined;
    try {
      return await run();
    } finally {
      if (timer) {
        clearInterval(timer);
        process.stdout.write("\r\x1b[K");
      }
    }
  }
  close() {
    this.rl.close();
  }
}
