// Local evidence for an automatic request draft (P-019/P-021, user decision 2026-09-13):
// recent Git activity, the watch draft summary and the latest note left by the user's
// own Claude Code session. Everything stays on this computer until the user reviews the
// drafted request; only the drafted handoff is published, never the note or the diff.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { localAiTools, type LocalAiProvider } from "./local-ai.js";
import { atomicJson, digest, projectRoot, stateDir } from "./drafts.js";
import { containsSecret } from "../../../packages/contracts/src/files.js";
import { claudeSettingsPath, statusLineLauncher } from "./claude-usage.js";
import { LIMIT_PATTERN } from "./limits.js";

const exec = promisify(execFile);
export const NOTES_SUBCOMMAND = "claude-notes";
export const NOTE_MAX_CHARS = 4000;
export const NOTE_MAX_AGE_MS = 7 * 86400000;

export interface AiNote {
  root: string;
  at: string;
  source: "claude-code";
  note: string;
}
export const notePath = (root: string) =>
  join(stateDir(), "ai-notes", `${digest(root)}.json`);

// Claude Code Stop hook input: only `cwd` and `last_assistant_message` are used.
export async function recordAiNote(
  input: string,
  now = new Date(),
): Promise<AiNote | null> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(input);
  } catch {
    return null;
  }
  const cwd = typeof json.cwd === "string" ? json.cwd : null;
  const message =
    typeof json.last_assistant_message === "string"
      ? json.last_assistant_message.trim()
      : "";
  if (!cwd || !message) return null;
  let root: string;
  try {
    root = await projectRoot(cwd);
  } catch {
    return null; // Not a Git project: nothing tig could hand off.
  }
  const note = message.slice(0, NOTE_MAX_CHARS);
  if (containsSecret(note)) return null;
  const record: AiNote = {
    root,
    at: now.toISOString(),
    source: "claude-code",
    note,
  };
  await atomicJson(notePath(root), record);
  return record;
}
export async function loadAiNote(
  root: string,
  now = Date.now(),
): Promise<AiNote | null> {
  try {
    const parsed = JSON.parse(await readFile(notePath(root), "utf8"));
    if (
      parsed?.root !== root ||
      typeof parsed.note !== "string" ||
      typeof parsed.at !== "string" ||
      now - Date.parse(parsed.at) > NOTE_MAX_AGE_MS
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

// --- hook install / uninstall (same pattern as the status line) ---------------------
interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}
export const isTigNotesHook = (handler: unknown) =>
  !!handler &&
  typeof handler === "object" &&
  typeof (handler as HookHandler).command === "string" &&
  (handler as HookHandler).command!.endsWith(NOTES_SUBCOMMAND);

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} is not a JSON object. Fix it before continuing.`);
  return parsed;
}
async function writeSettings(path: string, settings: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
}
export async function notesLauncher() {
  return (await statusLineLauncher()).replace(/ \S+$/, ` ${NOTES_SUBCOMMAND}`);
}
export async function installClaudeNotes(
  settingsPath = claudeSettingsPath(),
  launcher?: string,
) {
  const command = launcher ?? (await notesLauncher());
  const settings = await readSettings(settingsPath);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as HookEntry[]) : [];
  if (stop.some((e) => (e.hooks ?? []).some(isTigNotesHook)))
    return { changed: false };
  // Appended as its own entry: existing Stop hooks keep running unchanged.
  stop.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  settings.hooks = { ...hooks, Stop: stop };
  await writeSettings(settingsPath, settings);
  return { changed: true };
}
export async function uninstallClaudeNotes(
  settingsPath = claudeSettingsPath(),
) {
  const settings = await readSettings(settingsPath);
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks.Stop)) return { changed: false };
  const before = hooks.Stop as HookEntry[];
  const after = before
    .map((e) => ({
      ...e,
      hooks: (e.hooks ?? []).filter((h) => !isTigNotesHook(h)),
    }))
    .filter((e) => e.hooks.length);
  if (
    after.length === before.length &&
    after.every((e, i) => e.hooks.length === (before[i].hooks ?? []).length)
  )
    return { changed: false };
  if (after.length) hooks.Stop = after;
  else delete hooks.Stop;
  if (!Object.keys(hooks).length) delete settings.hooks;
  await writeSettings(settingsPath, settings);
  return { changed: true };
}
export async function clearAiNote(root: string) {
  await rm(notePath(root), { force: true });
}

// Which project is the user working on when tig runs outside one? The project of the
// newest local AI transcript or note, else the last project tig was used in.
export async function recentProject(
  lastRoot: string | undefined,
  now = Date.now(),
  options: { configDir?: string; codexHome?: string } = {},
): Promise<{ root: string; reason: string } | null> {
  const transcript = await latestSessionRoot({ ...options, now }).catch(
    () => null,
  );
  const dir = join(stateDir(), "ai-notes");
  let latest: AiNote | null = null;
  try {
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry), "utf8"));
        if (
          typeof parsed?.root !== "string" ||
          typeof parsed.at !== "string" ||
          now - Date.parse(parsed.at) > NOTE_MAX_AGE_MS
        )
          continue;
        if (!latest || Date.parse(parsed.at) > Date.parse(latest.at))
          latest = parsed;
      } catch {
        /* skip unreadable note */
      }
    }
  } catch {
    /* no notes yet */
  }
  const exists = async (path: string) =>
    (await stat(path)
      .then((s) => s.isDirectory())
      .catch(() => false)) &&
    (await projectRoot(path)
      .then(() => true)
      .catch(() => false));
  const noteAt = latest ? Date.parse(latest.at) : 0;
  if (transcript && transcript.at >= noteAt && (await exists(transcript.root)))
    return {
      root: transcript.root,
      reason: `your latest ${localAiTools[transcript.provider].name} session`,
    };
  if (latest && (await exists(latest.root)))
    return { root: latest.root, reason: "your latest Claude Code session" };
  if (lastRoot && (await exists(lastRoot)))
    return { root: lastRoot, reason: "your last tig project" };
  return null;
}

// --- the user's own AI sessions (read locally, never uploaded) --------------------
// Claude Code keeps transcripts under <config>/projects/<cwd with "/" → "-">/*.jsonl and
// Codex under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl. tig reads the newest
// files to learn what the user last asked, what the tool last answered and which files
// it touched — the "where did I stop" evidence when a subscription runs out.
// What a session did to a path. Inside this file the kind decides which paths survive
// the cap and in what order they leave it, so a consumer that takes a PREFIX of
// `touched` gets the edits first. Nothing downstream reads `kind` itself yet:
// wizard.ts prioritizeFiles still takes `touched: string[]` and ranks every one of them
// 0, so a snapshot narrowed below the list's length cuts alphabetically instead. Give
// prioritizeFiles `contacts` and a rank per kind and this becomes a real selection.
export type PathContact = "edit" | "read" | "shell";
export interface TouchedPath {
  path: string;
  kind: PathContact;
}
export interface AiSession {
  provider: LocalAiProvider;
  at: string;
  cwd: string | null;
  // The Git project the session worked in: its cwd, else the repository of the files it touched.
  project: string | null;
  // The same paths as `contacts`, in the same order: what the file selection reads today.
  touched: string[];
  contacts: TouchedPath[];
  title: string | null;
  lastPrompt: string | null;
  lastAnswer: string | null;
  limitHit: boolean;
  file: string;
}
export const SESSION_MAX_AGE_MS = 7 * 86400000;
const SESSION_TEXT_MAX = 3000;
const TOUCHED_MAX = 200;
// A record is read as bytes and only decoded when it is going to be parsed, so one
// corrupt or concatenated line cannot cost more than this. Over it the line is skipped
// whole: a single string past V8's limit (~512 MB) throws out of reach of every catch,
// and the largest record any real transcript here holds is 3.2 MB.
const LINE_MAX = 8 * 1024 * 1024;
// One read per megabyte instead of one per 64 KB: the same bytes, ~16x fewer syscalls,
// which is what a transcript on a network home directory pays for.
const READ_CHUNK = 1024 * 1024;

export const claudeProjectKey = (root: string) =>
  root.replace(/[^A-Za-z0-9-]/g, "-");
export const minutesAgo = (iso: string, now = Date.now()) =>
  Math.max(0, Math.round((now - Date.parse(iso)) / 60000));

// A transcript is read whole, one line at a time. The head/tail windows this used to
// read saw ~2% of an active session (21 MB is a normal size here) and reported no
// touched files at all, because a session's tool calls are spread over the whole file.
// Only the running summary is kept: the last prompt, the last answer and the paths it
// touched, so memory follows neither the file size nor the line count.
// Lines are cut out of the raw bytes: a JS string is built only for a line that is
// going to be parsed, which is what keeps both the cost and the peak memory of a
// 92 MB rollout bounded (readline builds every line, however long, before yielding it).
const NEWLINE = 10;
// The same cut over a file already in memory.
function* linesOf(buf: Buffer): Generator<Buffer> {
  let from = 0,
    at: number;
  while ((at = buf.indexOf(NEWLINE, from)) !== -1) {
    if (at > from && at - from <= LINE_MAX) yield buf.subarray(from, at);
    from = at + 1;
  }
  if (buf.length - from > 0 && buf.length - from <= LINE_MAX)
    yield buf.subarray(from);
}
async function* transcriptLines(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK });
  let rest: Buffer | null = null;
  let skipping = false; // inside a line over LINE_MAX: dropped, not buffered
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf: Buffer = rest?.length ? Buffer.concat([rest, chunk]) : chunk;
      rest = null;
      let from = 0,
        at: number;
      while ((at = buf.indexOf(NEWLINE, from)) !== -1) {
        if (skipping) skipping = false;
        else if (at > from && at - from <= LINE_MAX)
          yield buf.subarray(from, at);
        from = at + 1;
      }
      const tail: Buffer = buf.subarray(from);
      if (skipping || tail.length > LINE_MAX) skipping = true;
      else if (tail.length) rest = tail;
    }
    if (!skipping && rest?.length) yield rest;
  } finally {
    stream.destroy();
  }
}
// `needle` skips lines that cannot hold what the caller is looking for before they are
// decoded at all — a byte search over a line is a fraction of parsing it as JSON.
async function* transcriptRecords(
  path: string,
  needle?: Buffer,
): AsyncGenerator<any> {
  for await (const line of transcriptLines(path)) {
    if (needle && line.indexOf(needle) === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      continue; // a half-written last line, or a line that is not a record
    }
    if (parsed && typeof parsed === "object") yield parsed;
  }
}
// The first records of a transcript, for deciding whether the rest is worth reading.
async function transcriptHead(path: string, lines: number): Promise<any[]> {
  const head: any[] = [];
  let seen = 0;
  for await (const line of transcriptLines(path)) {
    if (seen++ >= lines) break;
    try {
      const parsed = JSON.parse(line.toString("utf8"));
      if (parsed && typeof parsed === "object") head.push(parsed);
    } catch {
      /* not a record */
    }
  }
  return head;
}
// Codex types the agent's blocks "Text" and the user's "text"; the type is compared
// case-insensitively so neither tool's casing decides whether text is found.
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b) =>
        b &&
        typeof b === "object" &&
        typeof b.type === "string" &&
        ["text", "input_text", "output_text"].includes(b.type.toLowerCase()) &&
        typeof b.text === "string",
    )
    .map((b) => b.text as string)
    .join("\n");
}
// Editor/system injections (<system-reminder>, <ide_selection>, pasted-file headers) are not the user's words.
function cleanText(text: string | null | undefined): string | null {
  if (!text) return null;
  let t = text.replace(/<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ");
  const request = t.match(/## My request:\s*([\s\S]*)$/);
  if (request) t = request[1];
  t = t.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, SESSION_TEXT_MAX) : null;
}
// A transcript file: its size is part of what the scan budgets, and part of the key
// that says a parse of it is still valid.
interface TranscriptFile {
  path: string;
  mtime: number;
  size: number;
}
const dirMtime = (dir: string) =>
  stat(dir).then(
    (s) => s.mtimeMs,
    () => null,
  );
const statTranscript = (path: string) =>
  stat(path).then(
    (s) => (s.isFile() ? { path, mtime: s.mtimeMs, size: s.size } : null),
    () => null,
  );
// One tig run scans the same folders twice — the machine-wide recent list, then this
// project's own session. A folder Claude Code has written 5000 transcripts into costs
// ~2 statx per file, so the second scan was ~10,000 syscalls for a folder whose newest
// file had not moved. What a folder HOLDS is its own mtime, so a transcript added,
// removed or renamed is always seen again; the winner is re-stated because an append
// changes the file and not the folder.
const newestFiles = new Map<string, { at: number; found: string | null }>();
async function newestFile(dir: string) {
  // Read before the listing, never after: a transcript that lands in between then makes
  // the folder look newer than what was remembered, and the next scan sees it.
  const at = await dirMtime(dir);
  if (at === null) return null;
  const known = newestFiles.get(dir);
  if (known?.at === at)
    return known.found ? await statTranscript(known.found) : null;
  let newest: TranscriptFile | null = null;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s?.isFile() && (!newest || s.mtimeMs > newest.mtime))
      newest = { path, mtime: s.mtimeMs, size: s.size };
  }
  newestFiles.set(dir, { at, found: newest?.path ?? null });
  return newest;
}
// Every .jsonl under a folder, newest first (rollouts, a session's subagent transcripts).
// Remembered for the run against the mtime of every folder the walk went through, for
// the same reason as above: 2016 rollouts were walked and stat-ed twice for one answer.
const walked = new Map<
  string,
  { dirs: [string, number | null][]; files: TranscriptFile[] }
>();
async function listTranscripts(
  dir: string,
  depth: number,
  keep: (name: string) => boolean,
  tag: string,
) {
  const key = `${tag}:${dir}`;
  const known = walked.get(key);
  if (
    known &&
    (await Promise.all(known.dirs.map(([d]) => dirMtime(d)))).every(
      (at, i) => at === known.dirs[i][1],
    )
  )
    return known.files;
  const files: TranscriptFile[] = [];
  const dirs: [string, number | null][] = [];
  const walk = async (at: string, left: number) => {
    const mtime = await dirMtime(at);
    let entries: Dirent[];
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      dirs.push([at, null]);
      return;
    }
    dirs.push([at, mtime]);
    for (const e of entries) {
      const path = join(at, e.name);
      if (e.isDirectory() && left > 0) await walk(path, left - 1);
      else if (e.isFile() && keep(e.name)) {
        const s = await stat(path).catch(() => null);
        if (s) files.push({ path, mtime: s.mtimeMs, size: s.size });
      }
    }
  };
  await walk(dir, depth);
  files.sort((a, b) => b.mtime - a.mtime);
  walked.set(key, { dirs, files });
  return files;
}
// Codex rollout files, newest first (sessions/YYYY/MM/DD/rollout-*.jsonl).
const listRollouts = (sessions: string) =>
  listTranscripts(sessions, 4, (n) => n.endsWith(".jsonl"), "rollouts");
const claudeProjectsDir = (configDir?: string) =>
  join(
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
  );
const codexSessionsDir = (codexHome?: string) =>
  join(
    codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "sessions",
  );

// Paths a session's tool calls worked on. System locations are not project evidence.
const SYSTEM_PATH =
  /^\/(proc|dev|sys|usr|etc|bin|lib|lib64|opt|var|run|snap)(\/|$)/;
// Tool arguments that name a file. "cwd" and "directory" name the folder a tool ran in,
// which is not a file a handoff can publish, so they are not collected; "path" and
// "target" (Glob, Grep) name either, so what they name is looked at once.
const PATH_KEYS = new Set(["file_path", "path", "notebook_path", "target"]);
const FOLDER_KEYS = new Set(["path", "target"]);
// What a file name is made of. Not \w: it is ASCII-only, so every name outside ASCII was
// harvested cut off at its first non-ASCII byte — "docs/notion/tig-사용안내서.md" was
// recorded as the path "docs/notion/tig-", which names nothing and still passed the
// existence check because its parent folder is real. Marks are included so a name in
// decomposed form (what macOS stores) is one name and not a name plus its accents.
const NAME = "\\p{L}\\p{N}\\p{M}_.@+-";
const ABS_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}_.:])\\/(?:[${NAME}]+\\/)+[${NAME}]+`,
  "gu",
);
// Edits are the strongest contact and win when a file was also read or shelled at.
const CONTACT_RANK: Record<PathContact, number> = {
  shell: 0,
  read: 1,
  edit: 2,
};
// Free text yields far more candidates than real paths; the stat calls that confirm
// them are bounded by this.
const CANDIDATE_MAX = 2 * TOUCHED_MAX;
// Paths are held while the transcript is read and ranked once at the end, so a later
// contact can still displace an earlier one. Dropping new paths at TOUCHED_MAX instead
// would keep the 200 a session touched first and lose the files it stopped in — the
// opposite of what a handoff needs.
const STORE_MAX = 8 * TOUCHED_MAX;
interface Contact {
  kind: PathContact;
  at: number; // the timestamp of the record that named it
  seq: number;
}
// What the cap keeps: an edited file over one that was read over one merely named in a
// command, and among equals the one the session came back to last.
const byRelevance = (a: Contact, b: Contact) =>
  CONTACT_RANK[b.kind] - CONTACT_RANK[a.kind] || b.at - a.at || b.seq - a.seq;
const rankedEntries = (map: Map<string, Contact>) =>
  [...map].sort((a, b) => byRelevance(a[1], b[1]));
function prune(map: Map<string, Contact>) {
  if (map.size <= STORE_MAX) return;
  const keep = rankedEntries(map).slice(0, STORE_MAX / 2);
  map.clear();
  for (const [path, contact] of keep) map.set(path, contact);
}
class TouchedPaths {
  private readonly kinds = new Map<string, Contact>();
  private readonly candidates = new Map<string, Contact>();
  private readonly ambiguous = new Set<string>();
  private seq = 0;
  // A transcript is read once and its subagent tree may be harvested on top of it more
  // than once in a run, with different amounts of the tree, so what the transcript alone
  // found is copied rather than re-read.
  clone() {
    const copy = new TouchedPaths();
    for (const [path, contact] of this.kinds) copy.kinds.set(path, contact);
    for (const [path, contact] of this.candidates)
      copy.candidates.set(path, contact);
    for (const path of this.ambiguous) copy.ambiguous.add(path);
    copy.seq = this.seq;
    copy.at = this.at;
    return copy;
  }
  // When the record being read happened. Recency decides which paths survive the cap,
  // so it is read from the transcript rather than from the order of the files parsed.
  at = 0;
  private put(map: Map<string, Contact>, path: string, contact: Contact) {
    const had = map.get(path);
    map.set(path, {
      // The strongest contact a path ever had is the one it keeps, at its latest time.
      kind:
        had && CONTACT_RANK[had.kind] > CONTACT_RANK[contact.kind]
          ? had.kind
          : contact.kind,
      at: Math.max(contact.at, had?.at ?? 0),
      seq: contact.seq,
    });
    prune(map);
  }
  // A structured tool argument names a path the tool really used, so it is taken as
  // it is — the file may well be gone by the time tig reads the transcript. An argument
  // that can name a folder just as well is remembered for one look on disk.
  add(value: unknown, kind: PathContact, mayBeFolder = false) {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      SYSTEM_PATH.test(value)
    )
      return;
    this.put(this.kinds, value, { kind, at: this.at, seq: this.seq++ });
    if (mayBeFolder && this.ambiguous.size < STORE_MAX)
      this.ambiguous.add(value);
  }
  // Text is only a source of candidates: ABS_PATH matches inside a URL as well
  // ("https://github.com/o/r" → "/github.com/o/r"), so they are confirmed on disk.
  addFromText(text: unknown, kind: PathContact) {
    if (typeof text !== "string") return;
    for (const match of text.match(ABS_PATH) ?? []) {
      if (SYSTEM_PATH.test(match)) continue;
      this.put(this.candidates, match, { kind, at: this.at, seq: this.seq++ });
    }
  }
  async resolve(): Promise<TouchedPath[]> {
    const unconfirmed: [string, Contact][] = [];
    for (const [path, contact] of rankedEntries(this.candidates)) {
      if (this.kinds.has(path)) this.put(this.kinds, path, contact);
      else if (unconfirmed.length < CANDIDATE_MAX)
        unconfirmed.push([path, contact]);
    }
    // The checks are independent, so they run as one batch: awaited one at a time they
    // cost ~200 us each, which is most of the parse of a small transcript.
    const seen = new Map<string, Promise<boolean>>();
    const confirmed = await Promise.all(
      unconfirmed.map(([path]) => isTouchedFile(path, seen)),
    );
    unconfirmed.forEach(([path, contact], i) => {
      if (confirmed[i]) this.put(this.kinds, path, contact);
    });
    const ambiguous = [...this.ambiguous];
    const isFolder = await Promise.all(
      ambiguous.map((path) => isDirectory(path, seen)),
    );
    ambiguous.forEach((path, i) => {
      if (isFolder[i]) this.kinds.delete(path);
    });
    // One file is one slot. A session that reaches the same project through a symlinked
    // parent — /home/me/Proj beside /data/Proj — spells its files both ways and used to
    // store each spelling, so 40 of the 200 slots held a second copy of a file already
    // in the list and 40 real files were evicted for nothing. The FOLDER is resolved,
    // not the file: a file the session deleted as its last act still has to keep its
    // name. Merging happens before the cap, so the freed slots go to other files.
    const dirs = [...new Set([...this.kinds.keys()].map(dirname))];
    const real = new Map(
      await Promise.all(
        dirs.map(async (d) => [d, await realDirOf(d)] as const),
      ),
    );
    const merged = new Map<string, Contact>();
    for (const [path, contact] of this.kinds) {
      const at = join(real.get(dirname(path))!, basename(path));
      const had = merged.get(at);
      merged.set(
        at,
        had
          ? {
              kind:
                CONTACT_RANK[had.kind] >= CONTACT_RANK[contact.kind]
                  ? had.kind
                  : contact.kind,
              at: Math.max(had.at, contact.at),
              seq: Math.max(had.seq, contact.seq),
            }
          : contact,
      );
    }
    // What survives the cap. A file no repository owns — a scratch file under /tmp, a
    // download — cannot be part of a handoff however recently it was written, and a
    // long session writes a lot of them: unranked they took 113 of the 200 slots of
    // the session writing this. Below that it is the contact and then recency.
    const owned = new Map(
      await Promise.all(
        [...new Set([...merged.keys()].map(dirname))].map(
          async (dir) => [dir, !!(await repoRootOf(dir))] as const,
        ),
      ),
    );
    return [...merged]
      .map(([path, contact]) => ({
        path,
        contact,
        owned: owned.get(dirname(path)) ? 1 : 0,
      }))
      .sort((a, b) => b.owned - a.owned || byRelevance(a.contact, b.contact))
      .slice(0, TOUCHED_MAX)
      .map(({ path, contact }) => ({ path, kind: contact.kind }));
  }
}
const isDirectory = (path: string, cache: Map<string, Promise<boolean>>) => {
  let hit = cache.get(path);
  if (!hit) {
    hit = stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    );
    cache.set(path, hit);
  }
  return hit;
};
// Whether a path harvested from free text is a file this session worked on. The check
// is here to reject URL fragments, not history: a file the session renamed or deleted
// as its last act is exactly what a handoff has to mention, so a missing name inside a
// real directory still counts, while "/github.com/owner/repo" has no such directory.
// A path we are not allowed to stat is not evidence of absence either — and a
// directory is not a file the handoff needs, however well it exists.
async function isTouchedFile(
  path: string,
  dirs: Map<string, Promise<boolean>>,
) {
  try {
    return (await stat(path)).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    return await isDirectory(dirname(path), dirs);
  }
}
interface SessionTail {
  at: string;
  cwd: string | null;
  touched: string[];
  contacts: TouchedPath[];
  title: string | null;
  lastPrompt: string | null;
  lastAnswer: string | null;
  limitHit: boolean;
}
const tailFrom = (
  contacts: TouchedPath[],
  rest: Omit<SessionTail, "touched" | "contacts">,
): SessionTail => ({
  ...rest,
  touched: contacts.map((c) => c.path),
  contacts,
});
// Tools that change a file. Everything else that names a path looked at one.
const EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "Write",
]);
const TOOL_USE = Buffer.from('"tool_use"');
// A session's subagents write their own transcripts beside it, under
// <transcript without .jsonl>/subagents/**/agent-*.jsonl, and in a workflow-driven
// session that is where most of the file work happens: 136 MB against 25 MB of main
// transcript for the session writing this, and 68 of the 142 repository files it named
// — 8 of them files a subagent EDITED — were beyond the 32 MB this used to read.
// There is now one budget instead of two that each assumed the other was counting.
// A session this call is asked ABOUT is read whole; every other session's transcript
// and subagent tree come out of the caller's scan budget together.
interface ScanBudget {
  left: number;
}
// How much of a session's subagent tree a scan wants. "all": a handoff is being drafted
// out of THIS session, so every transcript its subagents wrote is part of the answer.
// A budget: some other project's session, read as far as the scan can afford.
// "none": the machine-wide list, which only has to place a session and say what the user
// asked — 292 subagent transcripts answer neither, and reading them for eight sessions
// was 257 MB of the 64 MB the scan believed it was bounded by.
type SubagentScope = "all" | "none" | ScanBudget;
const listSubagents = (transcript: string) =>
  listTranscripts(
    transcript.replace(/\.jsonl$/, ""),
    4,
    (n) => n.startsWith("agent-") && n.endsWith(".jsonl"),
    "subagents",
  );
async function subagentTranscripts(path: string, scope: SubagentScope) {
  if (scope === "none") return [];
  const files = await listSubagents(path);
  if (scope === "all") return files;
  const chosen: TranscriptFile[] = [];
  let left = scope.left;
  for (const f of files) {
    if (f.size > left) continue;
    left -= f.size;
    chosen.push(f);
  }
  return chosen;
}
// Reading is most of what a subagent tree costs — 136 MB of it is ~700 ms of read and
// ~150 ms of everything else — and the kernel will do several reads at once, so the
// next files are read while the current one is harvested. The records still come out in
// file order: what the cap keeps must not depend on which read finished first. A file
// too big for the window is streamed on its turn, so one huge transcript is never held
// whole in memory.
const READ_AHEAD_FILES = 8;
const READ_AHEAD_BYTES = 16 * 1024 * 1024;
async function* subagentLines(files: TranscriptFile[]) {
  const ahead: (Promise<Buffer | null> | null)[] = files.map(() => null);
  let flight = 0;
  const start = (from: number) => {
    for (let i = from; i < files.length && i < from + READ_AHEAD_FILES; i++) {
      const f = files[i];
      if (
        ahead[i] ||
        f.size > READ_AHEAD_BYTES ||
        flight + f.size > READ_AHEAD_BYTES
      )
        continue;
      flight += f.size;
      ahead[i] = readFile(f.path).then(
        (b) => b,
        () => null,
      );
    }
  };
  for (const [i, f] of files.entries()) {
    start(i);
    const buf = ahead[i] ? await ahead[i] : null;
    if (ahead[i]) {
      ahead[i] = null;
      flight -= f.size;
    }
    if (buf) for (const line of linesOf(buf)) yield [f, line] as const;
    else
      for await (const line of transcriptLines(f.path))
        yield [f, line] as const;
  }
}
// A heredoc body is a file the command WRITES, not a file the command worked on. The
// probe scripts a session writes that way are full of module specifiers, and a missing
// name inside a real folder counts as touched, so `import … from ".../evidence.js"` put
// 18 paths this repository has never contained into the 200. The redirection target
// stands outside the body and is still collected.
const HEREDOC = /<<-?\s*(?:"([^"\n]*)"|'([^'\n]*)'|([\w.-]+))/;
function withoutHeredocBodies(command: string) {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const tag = lines[i].match(HEREDOC);
    if (!tag) continue;
    const end = tag[1] ?? tag[2] ?? tag[3];
    while (++i < lines.length && lines[i].trim() !== end) {
      /* the body is data, not paths */
    }
  }
  return kept.join("\n");
}
// The paths one tool call names. Subagent records carry these too: their tool calls are
// work the handoff is about, even though their text is not the user's conversation.
function harvestToolUse(content: unknown, touched: TouchedPaths) {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (
      !b ||
      typeof b !== "object" ||
      b.type !== "tool_use" ||
      !b.input ||
      typeof b.input !== "object"
    )
      continue;
    const kind: PathContact = EDIT_TOOLS.has(b.name) ? "edit" : "read";
    for (const [key, value] of Object.entries(b.input))
      if (PATH_KEYS.has(key)) touched.add(value, kind, FOLDER_KEYS.has(key));
    // Bash (input keys: command, description, timeout) carries its paths inside
    // the command line, and running commands is most of what a session does.
    const command = (b.input as Record<string, unknown>).command;
    touched.addFromText(
      typeof command === "string" ? withoutHeredocBodies(command) : command,
      "shell",
    );
  }
}
// Everything the transcript itself says, kept apart from the subagent tree: it is what
// places the session, and one run may harvest different amounts of that tree on top of
// the same transcript. Read once per run either way.
interface MainParse extends Omit<SessionTail, "touched" | "contacts"> {
  touched: TouchedPaths;
}
async function parseClaudeMain(
  path: string,
  fallbackAt: string,
): Promise<MainParse> {
  let title: string | null = null,
    lastPrompt: string | null = null,
    lastAnswer: string | null = null,
    limitHit = false,
    at = fallbackAt,
    cwd: string | null = null;
  const touched = new TouchedPaths();
  touched.at = Date.parse(fallbackAt) || 0;
  for await (const o of transcriptRecords(path)) {
    if (typeof o.timestamp === "string") {
      at = o.timestamp;
      touched.at = Date.parse(o.timestamp) || touched.at;
    }
    const content = o.message?.content;
    harvestToolUse(content, touched);
    if (o.isSidechain) continue; // subagent traffic: work, not conversation
    if (o.type === "ai-title" && typeof o.aiTitle === "string")
      title = o.aiTitle;
    if (typeof o.cwd === "string") cwd = o.cwd;
    const text = cleanText(textBlocks(content));
    if (o.type === "user" && text) lastPrompt = text;
    if (o.type === "assistant" && text) {
      lastAnswer = text;
      limitHit = LIMIT_PATTERN.test(text);
    }
  }
  return { at, cwd, title, lastPrompt, lastAnswer, limitHit, touched };
}
async function parseClaudeTranscript(
  main: MainParse,
  subagents: TranscriptFile[],
): Promise<SessionTail> {
  const { touched: found, ...rest } = main;
  const touched = found.clone();
  // Only the tool calls are wanted here, so lines that hold none are never decoded, and
  // when a record is the time is read from that record alone — nothing carries over from
  // the file read before it, which is what lets the files be read ahead of the harvest.
  for await (const [f, line] of subagentLines(subagents)) {
    if (line.indexOf(TOOL_USE) === -1) continue;
    let o: any;
    try {
      o = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    touched.at =
      (typeof o.timestamp === "string" ? Date.parse(o.timestamp) : 0) ||
      f.mtime;
    harvestToolUse(o.message?.content, touched);
  }
  return tailFrom(await touched.resolve(), rest);
}
// Where a Codex session worked. Its cwd is the editor's, often the user's home folder
// with the real project listed beside it in turn_context.workspace_roots, so the folder
// its own file work happened under wins; then the more specific folder, and the home
// folder itself only when nothing else is on offer. The cwd is ranked with the roots so
// a cwd inside a root still beats the root, and it stays the answer when there are none.
function pickProjectFolder(
  candidates: unknown[],
  contacts: TouchedPath[],
  cwd: string | null,
): string | null {
  const home = homedir();
  const outranks = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best: string | null = null,
    bestKey = [-1, -1, -1, -1];
  for (const folder of candidates) {
    if (
      typeof folder !== "string" ||
      !folder.startsWith("/") ||
      folder === "/" ||
      SYSTEM_PATH.test(folder)
    )
      continue;
    const key = [
      // Whether file work happened under it, not how much: a folder that only wins by
      // being an ANCESTOR of the session's own contains every contact its child does,
      // so counting would hand a workspace root the project that sits inside it.
      contacts.some((c) => c.path === folder || c.path.startsWith(`${folder}/`))
        ? 1
        : 0,
      folder === home ? 0 : 1,
      folder === cwd ? 1 : 0,
      folder.split("/").length,
    ];
    if (outranks(key, bestKey)) {
      best = folder;
      bestKey = key;
    }
  }
  return best;
}
async function parseCodexRollout(
  path: string,
  fallbackAt: string,
): Promise<SessionTail> {
  let lastPrompt: string | null = null,
    lastAnswer: string | null = null,
    limitHit = false,
    at = fallbackAt,
    metaCwd: string | null = null,
    roots: unknown = null;
  const touched = new TouchedPaths();
  touched.at = Date.parse(fallbackAt) || 0;
  const answered = (text: string | null) => {
    if (!text) return;
    lastAnswer = text;
    limitHit = LIMIT_PATTERN.test(text);
  };
  for await (const o of transcriptRecords(path)) {
    if (typeof o.timestamp === "string")
      touched.at = Date.parse(o.timestamp) || touched.at;
    const p = o.payload;
    if (!p || typeof p !== "object") continue;
    if (o.type === "session_meta" && typeof p.cwd === "string") metaCwd = p.cwd;
    else if (o.type === "turn_context") {
      if (Array.isArray(p.workspace_roots) && p.workspace_roots.length)
        roots = p.workspace_roots;
      if (!metaCwd && typeof p.cwd === "string") metaCwd = p.cwd;
    } else if (o.type === "event_msg") {
      // Codex up to 0.153 wrote the text as its own record …
      if (p.type === "user_message" && typeof p.message === "string")
        lastPrompt = cleanText(p.message) ?? lastPrompt;
      if (p.type === "agent_message" && typeof p.message === "string")
        answered(cleanText(p.message));
      // … 0.154 writes completed items instead, and nothing else carries the text.
      if (p.type === "item_completed" && p.item && typeof p.item === "object") {
        const item = p.item;
        const text = () =>
          cleanText(
            textBlocks(item.content) ||
              (typeof item.text === "string" ? item.text : ""),
          );
        if (item.type === "UserMessage") lastPrompt = text() ?? lastPrompt;
        else if (item.type === "AgentMessage") answered(text());
        else if (item.type === "FileChange" && item.changes)
          for (const changed of Object.keys(item.changes))
            touched.add(changed, "edit");
      }
    } else if (
      o.type === "response_item" &&
      ["custom_tool_call", "function_call"].includes(p.type)
    ) {
      const kind: PathContact = p.name === "apply_patch" ? "edit" : "shell";
      touched.addFromText(p.input, kind);
      touched.addFromText(p.arguments, kind);
    }
    if (typeof o.timestamp === "string") at = o.timestamp;
  }
  const contacts = await touched.resolve();
  return tailFrom(contacts, {
    at,
    cwd:
      pickProjectFolder(
        [...(Array.isArray(roots) ? roots : []), metaCwd],
        contacts,
        metaCwd,
      ) ?? metaCwd,
    title: null,
    lastPrompt,
    lastAnswer,
    limitHit,
  });
}
// The repository a directory belongs to, found the way `git rev-parse --show-toplevel`
// finds it but without forking it: a session that touched 200 files spans ~85
// directories, and a git child process costs 6.5 ms each — half a second of the wait
// before tig has drafted anything. Every folder on the way up is remembered as its
// promise, not its result, because the paths of one transcript are resolved as a batch
// and a cache filled only when a walk ENDS would let all of them walk to / at once.
const repoRoots = new Map<string, Promise<string | null>>();
// The one name a folder really has. Remembered per folder like the repository walk above,
// and for the same reason: the paths of one transcript are resolved as a batch. A folder
// that cannot be resolved (it is gone, or unreadable) keeps the name it was reached by.
const realDirs = new Map<string, Promise<string>>();
function realDirOf(dir: string): Promise<string> {
  let known = realDirs.get(dir);
  if (!known) {
    known = realpath(dir).catch(() => dir);
    realDirs.set(dir, known);
  }
  return known;
}
function repoRootOf(dir: string): Promise<string | null> {
  let known = repoRoots.get(dir);
  if (!known) {
    known = findRepoRoot(dir);
    repoRoots.set(dir, known);
  }
  return known;
}
async function findRepoRoot(dir: string): Promise<string | null> {
  const at = await realDirOf(dir);
  // A .git directory, or the file a worktree or submodule leaves in its place.
  if (
    await stat(join(at, ".git")).then(
      () => true,
      () => false,
    )
  )
    return at;
  const up = dirname(at);
  return up === at ? null : repoRootOf(up);
}
// The Git project a session worked in: its cwd when that is a repository, else the
// repository most of its touched files belong to (an editor session often starts in
// the home folder and edits files inside a project).
export async function projectFromSession(s: {
  cwd: string | null;
  touched: string[];
}): Promise<string | null> {
  if (s.cwd) {
    const root = await repoRootOf(s.cwd);
    if (root) return root;
  }
  const counts = new Map<string, number>();
  for (const path of s.touched) {
    const root = await repoRootOf(dirname(path));
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best: string | null = null,
    bestCount = 0;
  for (const [root, count] of counts)
    if (count > bestCount) {
      best = root;
      bestCount = count;
    }
  return best;
}
// Transcript text reaches the screen and the local AI. A piece that looks like a secret
// is dropped here (never shown, never sent) rather than left for the AI payload check,
// which would abort every AUTO run with text the user cannot edit.
export const SECRET_OMITTED = "[omitted: looked like a secret]";
const safeText = (text: string | null) =>
  text && containsSecret(text) ? SECRET_OMITTED : text;
export function redactSession<T extends SessionTail>(s: T): T {
  const contacts = s.contacts.filter((c) => !containsSecret(c.path));
  return {
    ...s,
    title: safeText(s.title),
    lastPrompt: safeText(s.lastPrompt),
    lastAnswer: safeText(s.lastAnswer),
    contacts,
    touched: contacts.map((c) => c.path),
  };
}
// One tig run scans the same transcripts twice — the recent-session list to pick a
// project, then that project's own session — so a parse is kept for the rest of the
// run. The key is what was READ, which for a Claude session is the transcript and the
// subagent transcripts it drags in: those two scans are seconds to minutes apart, a
// Task-driven session is idle in its own transcript while its subagents write, and
// keying on the main file alone served the work of those subagents from a stale entry.
const parsedSessions = new Map<string, AiSession | null>();
const parsedMains = new Map<string, MainParse>();
const PARSED_MAX = 64;
const remember = <T>(cache: Map<string, T>, key: string, value: T) => {
  if (cache.size >= PARSED_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
};
async function sessionFrom(
  provider: LocalAiProvider,
  file: TranscriptFile,
  scope: SubagentScope,
): Promise<AiSession | null> {
  const subagents =
    provider === "claude" ? await subagentTranscripts(file.path, scope) : [];
  const bytes = subagents.reduce((n, f) => n + f.size, 0);
  const key = [
    provider,
    file.path,
    file.mtime,
    file.size,
    subagents.length,
    bytes,
    Math.max(0, ...subagents.map((f) => f.mtime)),
  ].join(":");
  const cached = parsedSessions.get(key);
  if (cached !== undefined) return cached; // nothing is read, so nothing is charged
  if (typeof scope === "object") scope.left -= bytes;
  return remember(
    parsedSessions,
    key,
    await parseSession(provider, file, subagents),
  );
}
async function parseSession(
  provider: LocalAiProvider,
  file: TranscriptFile,
  subagents: TranscriptFile[],
): Promise<AiSession | null> {
  const at = new Date(file.mtime).toISOString();
  const mainKey = `${file.path}:${file.mtime}:${file.size}`;
  const parsed =
    provider === "claude"
      ? await parseClaudeTranscript(
          parsedMains.get(mainKey) ??
            remember(
              parsedMains,
              mainKey,
              await parseClaudeMain(file.path, at),
            ),
          subagents,
        )
      : await parseCodexRollout(file.path, at);
  // A session whose text is missing (a tool changed its record format, a transcript
  // holds nothing but tool calls) is still evidence when it names what it worked on.
  if (!parsed.lastPrompt && !parsed.lastAnswer && !parsed.touched.length)
    return null;
  const clean = redactSession(parsed);
  return {
    provider,
    ...clean,
    project: await projectFromSession(clean),
    file: file.path,
  };
}
export const sessionBelongsTo = (
  s: { project: string | null; cwd: string | null },
  root: string,
) =>
  s.project === root ||
  s.cwd === root ||
  (s.cwd?.startsWith(`${root}/`) ?? false);
// How many transcripts of OTHER folders/projects are parsed while looking for one that
// worked in the given project (a session started in the home folder editing its files).
const FOREIGN_SCAN_MAX = 40;
// …and how many bytes of them. A file count bounds nothing: this computer holds 92 MB
// and 84 MB rollouts, so 40 of them is 3.7 GB of parsing before tig can say "no session
// for this project". A transcript that says it worked in this project is read whole
// whatever its size; the rest share this budget, newest first, subagent trees included.
// This is not the window the round before had — no transcript is read in part.
const SCAN_BYTES_MAX = 64 * 1024 * 1024;
interface ScanOptions {
  configDir?: string;
  codexHome?: string;
  now?: number;
  scanBytes?: number;
}
const scanBudget = (options: ScanOptions): ScanBudget => ({
  left: options.scanBytes ?? SCAN_BYTES_MAX,
});
// The project's newest Claude Code session. Its own folders (<key>, <key>-<subdir>) are
// read directly, so any number of newer sessions elsewhere can never hide it; other
// folders' newest transcripts are checked by the files they touched, bounded.
export async function readClaudeSession(
  root: string,
  options: ScanOptions = {},
): Promise<AiSession | null> {
  const now = options.now ?? Date.now();
  const projects = claudeProjectsDir(options.configDir);
  const key = claudeProjectKey(root);
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return null;
  }
  const candidates: (TranscriptFile & { own: boolean })[] = [];
  for (const d of dirs) {
    const c = await newestFile(join(projects, d));
    if (c && now - c.mtime <= SESSION_MAX_AGE_MS)
      candidates.push({ ...c, own: d === key || d.startsWith(`${key}-`) });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let foreign = 0;
  const budget = scanBudget(options);
  for (const c of candidates) {
    if (!c.own) {
      if (foreign++ >= FOREIGN_SCAN_MAX || c.size > budget.left) continue;
      budget.left -= c.size;
    }
    // The transcript says on its own where the session worked, and it is cached apart
    // from the subagent tree, so nothing is spent on that tree until a session turns out
    // to be this project's — and then all of it, because its subagents did the work
    // being handed over. The folder under projects/ is named after where the session
    // STARTED, which is often not where it worked: the session writing this started in a
    // home folder and this project's key does not match its folder at all.
    let s = await sessionFrom("claude", c, "none").catch(() => null);
    // The one other reason to spend the budget on a tree: a session the transcript
    // cannot place, which started outside a repository and let its subagents name files.
    if (!s?.project)
      s =
        (await sessionFrom("claude", c, c.own ? "all" : budget).catch(
          () => null,
        )) ?? s;
    // The transcript's own timestamp decides its age (file mtimes lie after copies).
    if (!s || now - Date.parse(s.at) > SESSION_MAX_AGE_MS) continue;
    // A transcript without any cwd line is trusted to its own folder.
    if ((c.own && !s.cwd) || sessionBelongsTo(s, root))
      return (await sessionFrom("claude", c, "all").catch(() => null)) ?? s;
  }
  return null;
}
// Which project a rollout says it ran in, from its first records alone. Codex writes
// session_meta first and turn_context early, so this costs one read of the head and
// tells us whether a 92 MB rollout is this project's before parsing it.
async function rolloutClaims(path: string, root: string) {
  const claims = (f: unknown) =>
    typeof f === "string" && (f === root || f.startsWith(`${root}/`));
  for (const o of await transcriptHead(path, 40)) {
    const p = o?.payload;
    if (!p || typeof p !== "object") continue;
    if (o.type !== "session_meta" && o.type !== "turn_context") continue;
    if (
      claims(p.cwd) ||
      (Array.isArray(p.workspace_roots) && p.workspace_roots.some(claims))
    )
      return true;
  }
  return false;
}
export async function readCodexSession(
  root: string,
  options: ScanOptions = {},
): Promise<AiSession | null> {
  const now = options.now ?? Date.now();
  const files = await listRollouts(codexSessionsDir(options.codexHome));
  const budget = scanBudget(options);
  for (const f of files.slice(0, FOREIGN_SCAN_MAX)) {
    if (now - f.mtime > SESSION_MAX_AGE_MS) break;
    const claims = f.size <= budget.left || (await rolloutClaims(f.path, root));
    if (!claims) continue;
    budget.left -= f.size;
    // Codex writes no subagent transcripts, so a rollout is all there is to read.
    const session = await sessionFrom("codex", f, "none").catch(() => null);
    if (
      session &&
      now - Date.parse(session.at) <= SESSION_MAX_AGE_MS &&
      sessionBelongsTo(session, root)
    )
      return session;
  }
  return null;
}
// The newest sessions on this computer across both tools, newest first.
export async function listRecentSessions(
  options: ScanOptions & { limit?: number } = {},
): Promise<AiSession[]> {
  const now = options.now ?? Date.now();
  const files: (TranscriptFile & { provider: LocalAiProvider })[] = [];
  const projects = claudeProjectsDir(options.configDir);
  for (const d of await readdir(projects).catch(() => [] as string[])) {
    const c = await newestFile(join(projects, d));
    if (c) files.push({ ...c, provider: "claude" });
  }
  for (const r of (
    await listRollouts(codexSessionsDir(options.codexHome))
  ).slice(0, 20))
    files.push({ ...r, provider: "codex" });
  const recent = files
    .filter((f) => now - f.mtime <= SESSION_MAX_AGE_MS)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, options.limit ?? 8);
  const sessions: AiSession[] = [];
  const budget = scanBudget(options);
  for (const [i, f] of recent.entries()) {
    // What the user was doing last answers the question this list is asked, so the
    // newest transcript is read whatever it weighs; the rest share the budget.
    if (i > 0 && f.size > budget.left) continue;
    budget.left -= f.size;
    // The list has to place a session and say what the user asked, and the transcript
    // says both. Only a session it cannot place is worth its subagents' transcripts.
    let s = await sessionFrom(f.provider, f, "none").catch(() => null);
    if (!s?.project)
      s = (await sessionFrom(f.provider, f, budget).catch(() => null)) ?? s;
    if (s) sessions.push(s);
  }
  return sessions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
// The project of the newest transcript on this computer, whichever tool wrote it.
export async function latestSessionRoot(
  options: ScanOptions = {},
): Promise<{ root: string; provider: LocalAiProvider; at: number } | null> {
  const s = (await listRecentSessions(options)).find((x) => x.project);
  return s
    ? { root: s.project!, provider: s.provider, at: Date.parse(s.at) }
    : null;
}
// Whether a session RAN in this project, rather than reaching it through a file it
// happened to name. Resolved first: the same project is spelled two ways here (a home
// folder symlink to the working disk), and a spelling is not a different project.
async function ranIn(s: AiSession, root: string) {
  if (!s.cwd) return true; // no cwd line at all: matched by its own project folder
  const [cwd, at] = await Promise.all([realDirOf(s.cwd), realDirOf(root)]);
  return cwd === at || cwd.startsWith(`${at}/`);
}
// The project's newest session across both tools. Reads the project directly instead of
// the machine-wide recent list, whose cap would drop it behind newer sessions elsewhere.
// Between the two tools, standing comes before recency: a session that ran in the
// project outranks one that only reached it through a file it touched. Recency alone
// handed the handoff to whichever window was used last — an editor sitting in the home
// folder that ran one `cat` on one file inside the project beat the session that had
// been working in it all day, and shipped its four paths instead of that session's two
// hundred. Two sessions of the same standing are still decided by which is newer.
export async function latestAiSession(
  root: string,
  options: ScanOptions = {},
): Promise<AiSession | null> {
  // A budget each: the two scans run at once, and one counter between them would make
  // the answer depend on which read came back first.
  const [claude, codex] = await Promise.all([
    readClaudeSession(root, options).catch(() => null),
    readCodexSession(root, options).catch(() => null),
  ]);
  if (!claude || !codex) return claude ?? codex;
  const [inClaude, inCodex] = await Promise.all([
    ranIn(claude, root),
    ranIn(codex, root),
  ]);
  if (inClaude !== inCodex) return inClaude ? claude : codex;
  return Date.parse(claude.at) >= Date.parse(codex.at) ? claude : codex;
}

// --- evidence for an automatic draft ----------------------------------------------
// The commit `tig init` makes in an empty project is not work the user did.
const BASELINE_COMMIT = /Initialize project for Tokenisgold/;
export interface Evidence {
  root: string;
  branch: string;
  commits: string[];
  changed: string[];
  changedCount: number;
  note: AiNote | null;
  session: AiSession | null;
}
export async function gatherEvidence(
  root: string,
  options: {
    now?: number;
    git?: (root: string, args: string[]) => Promise<string>;
    session?: AiSession | null;
    configDir?: string;
    codexHome?: string;
  } = {},
): Promise<Evidence> {
  const now = options.now ?? Date.now();
  const git =
    options.git ??
    (async (r: string, args: string[]) =>
      (await exec("git", ["-C", r, ...args], { maxBuffer: 64_000_000 }))
        .stdout);
  const safe = async (args: string[]) => {
    try {
      return await git(root, args);
    } catch {
      return "";
    }
  };
  const branch =
    (await safe(["branch", "--show-current"])).trim() || "(detached)";
  const commits = (
    await safe(["log", "--since=14.days", "-15", "--format=%h %s (%cr)"])
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !BASELINE_COMMIT.test(l));
  const status = (await safe(["status", "--short", "--untracked-files=normal"]))
    .split("\n")
    .filter(Boolean);
  const changed = status.slice(0, 12).map((l) => l.trim());
  const note = await loadAiNote(root, now);
  const session =
    options.session !== undefined
      ? options.session
      : await latestAiSession(root, {
          now,
          configDir: options.configDir,
          codexHome: options.codexHome,
        });
  return {
    root,
    branch,
    commits,
    changed,
    changedCount: status.length,
    note,
    session,
  };
}
export const hasEvidence = (e: Evidence) =>
  e.commits.length > 0 || e.changedCount > 0 || !!e.note || !!e.session;
const preview = (text: string, max: number) =>
  `${text.replace(/\s+/g, " ").slice(0, max)}${text.length > max ? "…" : ""}`;

// A compact picture of what tig goes on; the drafted request is what the user reviews.
export function renderEvidence(e: Evidence, now = Date.now()) {
  const facts = [`branch ${e.branch}`];
  facts.push(
    e.commits.length
      ? `${e.commits.length} commit${e.commits.length > 1 ? "s" : ""} in 14 days (latest: ${preview(e.commits[0].replace(/^[0-9a-f]+ /, "").replace(/ \([^()]*\)$/, ""), 60)})`
      : "no commits in 14 days",
  );
  facts.push(
    e.changedCount
      ? `${e.changedCount} uncommitted file${e.changedCount > 1 ? "s" : ""} (${e.changed
          .slice(0, 4)
          .map((c) => c.replace(/^\S+\s+/, ""))
          .join(", ")}${e.changedCount > 4 ? ", …" : ""})`
      : "no uncommitted changes",
  );
  const lines = [`Found: ${facts.join(" · ")}`];
  if (e.session) {
    const s = redactSession(e.session);
    const tool = localAiTools[s.provider].name;
    lines.push(
      `Latest ${tool} session, ${minutesAgo(s.at, now)} min ago (read locally, not uploaded)${s.limitHit ? " — it hit a usage limit, so the work stopped there" : ""}:`,
    );
    if (s.lastPrompt) lines.push(`  You asked: ${preview(s.lastPrompt, 160)}`);
    if (s.lastAnswer)
      lines.push(`  ${tool} last said: ${preview(s.lastAnswer, 200)}`);
  }
  if (e.note && (!e.session || e.note.at > e.session.at))
    lines.push(
      `Latest Claude Code note, ${minutesAgo(e.note.at, now)} min ago (local): ${preview(e.note.note, 200)}`,
    );
  if (!e.session && !e.note)
    lines.push(
      "No local AI session found for this project; the draft uses the Git activity only.",
    );
  return lines.join("\n");
}
// Public part of the request (goes into request.md): commits and changed paths only.
export function evidenceRequest(e: Evidence) {
  const parts = [
    "AUTO: continue the recent work in this project and finish what is unfinished or blocked, based on the evidence below.",
    `Branch ${e.branch}.`,
  ];
  // Relative times ("3 hours ago") are display only; the request text stays stable so an
  // unchanged project reuses the saved draft instead of calling the AI again.
  if (e.commits.length)
    parts.push(
      `Recent commits: ${e.commits
        .slice(0, 8)
        .map((c) => c.replace(/ \([^()]*\)$/, ""))
        .join("; ")}.`,
    );
  if (e.changedCount)
    parts.push(
      `Uncommitted changes in ${e.changedCount} file(s): ${e.changed.slice(0, 8).join(", ")}.`,
    );
  return parts.join(" ").slice(0, 1900);
}
// Private part (local AI only, never published): the user's latest AI session and note.
export function evidenceClarification(e: Evidence) {
  const parts: string[] = [];
  if (e.session) {
    const s = redactSession(e.session);
    const tool = localAiTools[s.provider].name;
    parts.push(
      [
        `Latest ${tool} session (${s.at}), local context only:`,
        s.title ? `Topic: ${s.title}` : "",
        s.lastPrompt ? `User's last request: ${s.lastPrompt}` : "",
        s.lastAnswer ? `${tool}'s last answer: ${s.lastAnswer}` : "",
        s.limitHit
          ? "The session hit a usage limit; the work stopped at that point."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (e.note)
    parts.push(
      `Latest local AI note (${e.note.at}), for context only:\n${e.note.note}`,
    );
  return parts.join("\n\n");
}

// One line for the review screen: what the draft is based on.
export function summarizeEvidence(e: Evidence, now = Date.now()) {
  const parts: string[] = [];
  if (e.session)
    parts.push(
      `your ${localAiTools[e.session.provider].name} session ${minutesAgo(e.session.at, now)} min ago${e.session.limitHit ? " (it hit a usage limit)" : ""}`,
    );
  else if (e.note)
    parts.push(`your Claude Code note ${minutesAgo(e.note.at, now)} min ago`);
  if (e.commits.length)
    parts.push(
      `${e.commits.length} commit${e.commits.length > 1 ? "s" : ""} in 14 days`,
    );
  if (e.changedCount)
    parts.push(
      `${e.changedCount} uncommitted file${e.changedCount > 1 ? "s" : ""}`,
    );
  return parts.join(", ");
}
