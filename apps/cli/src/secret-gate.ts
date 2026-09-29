// ONE gate in front of every public branch. The rule "nothing that looks like a
// secret reaches a public branch" was implemented at four call sites, each
// reading something slightly different from what git would actually push: the
// requester scanned the working-tree file while the index published HEAD's blob
// (`git update-index --assume-unchanged` makes the two differ), and the worker
// scanned only blobs that decoded as UTF-8 while recording `scanned: true` for
// the rest (a CP949 or UTF-16 source file was published unread and undisclosed).
//
// So this gate reads neither the working tree nor a decoded copy. It takes the
// commit that is about to be pushed, lists the blobs that commit contains, and
// scans the stored bytes of each one. What it scans is what leaves the machine,
// byte for byte: `git cat-file` without `--filters` writes the blob as stored,
// which is what `git push` sends.
//
// The scan needs no encoding guess. Every pattern in packages/contracts/src/
// files.ts is plain ASCII, so the bytes are matched directly (see
// secretReasonsInBytes there), with a second pass over the same bytes minus
// their NULs so UTF-16/UTF-32 text is matched too.
//
// Because it lists the commit's whole tree, it also sees files the publishing
// code never touched: the worker's result commit is scanned in full, not just
// its diff, so a secret in a file the agent never edited is still caught.
//
// WHAT IT DOES NOT CATCH, so nobody reads an empty array as a proof:
//   - Encodings where ASCII is not one byte per character and not NUL-padded:
//     EBCDIC, UTF-7, and anything transport-encoded (base64, quoted-printable).
//   - Secrets inside a container the gate cannot open: a zip/gzip/PDF stream, an
//     encrypted archive, a git-LFS pointer's target, a rendered image.
//   - Blobs skipped on a magic number (BINARY_MAGIC below), which a file can
//     claim on purpose by starting with one.
//   - Anything the pattern table does not describe: a bare high-entropy
//     password, a vendor token format nobody listed, a passphrase in prose.
//   - A single match longer than the window overlap (64 KiB) that also happens
//     to straddle a window boundary.
//   - Paths and commit messages. The gate reads blob contents; path rules live
//     in protectedPathReason (packages/contracts/src/files.ts), and the commit
//     message is written by tig, not by the project.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { secretReasonsInBytes } from "../../../packages/contracts/src/files.js";

// A finding: the path in the commit and the class of pattern that matched.
// Never the matched text, never an offset — a hit is printed to a terminal, put
// in an error message and sent to the platform, and the secret must not travel
// with it.
export interface SecretHit {
  path: string;
  reason: string;
}
// A disclosure is a list of FILES, so it is grouped by path before it is capped.
// `hits` carries one entry per (path, pattern class), and a single file can trip
// three of them at once (`OPENAI_API_KEY = "sk-proj-…"` is an OpenAI-style key,
// a key assignment and a quoted secret assignment). Capping the raw hits lets
// that one file fill the whole list and hide every other file that must not be
// published — the opposite of what the list is for.
export const groupHitsByPath = (
  hits: readonly SecretHit[],
): { path: string; reasons: string[] }[] => {
  const byPath = new Map<string, string[]>();
  for (const h of hits) {
    const reasons = byPath.get(h.path);
    if (!reasons) byPath.set(h.path, [h.reason]);
    else if (!reasons.includes(h.reason)) reasons.push(h.reason);
  }
  return [...byPath].map(([path, reasons]) => ({ path, reasons }));
};
// One file the gate matched, with the pattern classes that matched in it — the
// shape of both answers a caller can give about a hit: "this is what was found"
// and "this is what somebody already accepted". Never the matched text.
export interface SecretAcceptance {
  path: string;
  reasons: string[];
}
// Splits a scan's hits into the ones an acceptance list covers and the ones it
// does not.
//
// Matching is exact on BOTH halves. Exact on the path because an acceptance is a
// statement about one file: a folder prefix would accept files nobody has seen.
// Exact on the class because the class is what the accepter was shown next to
// the path: a file accepted for holding a PEM header has not been accepted for
// the AWS key that appeared in it afterwards, and that second hit comes back
// refused with the disclosure it deserves.
//
// Nothing here relaxes the scan. The bytes are read the same way; this only says
// which findings someone has already answered for.
export const partitionHits = (
  hits: readonly SecretHit[],
  accepted: readonly SecretAcceptance[],
): { accepted: SecretHit[]; refused: SecretHit[] } => {
  const allowed = new Map<string, Set<string>>();
  for (const entry of accepted) {
    const reasons = allowed.get(entry.path) ?? new Set<string>();
    for (const reason of entry.reasons) reasons.add(reason);
    allowed.set(entry.path, reasons);
  }
  const out: { accepted: SecretHit[]; refused: SecretHit[] } = {
    accepted: [],
    refused: [],
  };
  for (const hit of hits)
    (allowed.get(hit.path)?.has(hit.reason) ? out.accepted : out.refused).push(
      hit,
    );
  return out;
};
export const HIT_NAME_CAP = 5;
// The shared shape behind every sentence about a gate hit: how many files, the
// first few named with their classes, and how many files are left over. The
// matched text is never part of it.
export const namedHits = (hits: readonly SecretHit[], cap = HIT_NAME_CAP) => {
  const files = groupHitsByPath(hits);
  return {
    files: files.length,
    named: files
      .slice(0, cap)
      .map((f) => `${f.path} (${f.reasons.join(", ")})`),
    more: Math.max(0, files.length - cap),
  };
};
// A blob whose bytes the gate did not read to the end: a known binary container
// (BINARY_MAGIC below) or a blob past a caller's ceiling. The callers publish
// this list next to what they publish, because "not examined" must never be read
// as "clean" — that mistake is hole (b), and a count nobody prints is the same
// mistake with better manners.
export interface UnexaminedBlob {
  path: string;
  reason: string;
  bytes: number;
}
export interface CommitScan {
  hits: SecretHit[];
  unexamined: UnexaminedBlob[];
  // Blob entries in the commit, `skip`, `only` and empty blobs applied: the
  // denominator for "N of M files were examined".
  blobs: number;
}
export const binarySkipReason = (format: string) =>
  `not scanned: ${format} (binary format)`;
export interface ScanCommitOptions {
  // The repository holding the commit (the request's temporary object store, the
  // worker's --separate-git-dir, a bare push repository).
  gitDir: string;
  // Only needed when the caller's git invocations expect one; the gate itself
  // reads objects, never the working tree.
  workTree?: string;
  // Anything git resolves to a commit: a sha, a ref, a range end.
  commit: string;
  // The caller's own locked-down environment (GIT_CONFIG_NOSYSTEM,
  // GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0). The gate adds nothing to
  // it, so it cannot widen what the caller allowed.
  env: NodeJS.ProcessEnv;
  // Paths that are definitionally not the requester's secrets: the request
  // documents tig writes itself (request.md, request.json). Exact tree paths.
  skip?: Iterable<string>;
  // Read only these tree paths. This is never for the commit that is about to be
  // pushed — that one is always read whole. It is for a SECOND scan asking a
  // question about a commit that is already public (what did the request commit
  // already match at these paths?), where reading the other thousand blobs
  // answers nothing.
  only?: Iterable<string>;
  // 0 (the default) means no ceiling: every blob is scanned to its last byte.
  // See SECRET_GATE_MAX_BYTES for what a non-zero value costs and discloses.
  maxBlobBytes?: number;
  // Scan blobs whose first bytes are a known binary container too (default
  // false: those are skipped, see BINARY_MAGIC).
  scanBinary?: boolean;
  timeoutMs?: number;
}

// The size ceiling, and what happens above it.
//
// The old call sites stopped reading at 10 MB because they read the whole file
// into memory (request-tree.ts SECRET_SCAN_LIMIT, worker-agent.ts
// SECRET_SCAN_MAX_BYTES). The gate streams, so memory no longer depends on blob
// size and the only remaining cost is time. Measured: a 524 MB synthetic commit
// (303 blobs) in ~13 s — ~6 s waiting on git cat-file, ~5.4 s matching, the rest
// copying and decoding — and this repository's own HEAD (245 blobs, 1.5 MB) in
// ~70 ms. The largest request there can be (TREE_BYTE_LIMIT, 1 GB) is therefore
// under half a minute, once, before a push of that same gigabyte that takes
// minutes.
//
// So the default is NO ceiling: `maxBlobBytes: 0` scans every byte of every
// blob, and no blob is ever published with bytes that were never looked at. A
// caller that wants the old behaviour passes SECRET_GATE_MAX_BYTES, which is the
// same 10 MB number as both constants above; then a blob larger than that is
// scanned up to the limit AND reported with UNSCANNED_REASON. Truncation is
// never silent — a caller cannot mistake "too big to finish" for "clean", which
// is exactly the mistake hole (b) was.
export const SECRET_GATE_MAX_BYTES = 10 * 1024 * 1024;
export const UNSCANNED_REASON =
  "not scanned: larger than the gate's scan limit";

// Bytes matched at once. The window carries the tail of the previous one so a
// pattern that straddles a read boundary is still seen; 64 KiB is far longer
// than any token the patterns describe, and longer than any plausible .netrc
// line (the one pattern whose length is bounded by a line rather than a count).
export const SCAN_WINDOW_BYTES = 1024 * 1024;
export const SCAN_OVERLAP_BYTES = 64 * 1024;
// Enough for every magic number below (mp4's is at offset 4).
const MAGIC_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 10 * 60000;

export class SecretGateError extends Error {
  constructor(message: string) {
    super(`SECRET_GATE_FAILED: ${message}`);
  }
}

// "Plainly binary" is a magic number at a fixed offset and nothing else. Not the
// extension, not "it failed to decode as UTF-8", not git's own binary flag
// (.gitattributes is a file the agent can write) — those are how a scan gets
// skipped for a file that is really text, which is the hole this gate exists to
// close. A file is skipped only when its first bytes say it is a container whose
// payload is compressed or entropy-coded, where the ASCII of a key does not
// survive as ASCII.
//
// Known limitation, stated plainly: this is a false-negative surface. These
// formats can still carry literal ASCII (a PNG tEXt chunk, a JPEG comment, an
// uncompressed ZIP entry, an uncompressed PDF stream, bytes appended after the
// end of an image), and prefixing "%PDF-" to a text file defeats the check on
// purpose. It is aimed at accidental disclosure, not at a requester who wants to
// publish their own key; a caller that wants no blind spot passes
// `scanBinary: true` and pays the scan.
export const BINARY_MAGIC: readonly {
  format: string;
  offset: number;
  bytes: readonly number[];
}[] = [
  {
    format: "PNG",
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { format: "JPEG", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { format: "GIF", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { format: "GIF", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { format: "PDF", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { format: "ZIP", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: "ZIP", offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { format: "ZIP", offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] },
  { format: "gzip", offset: 0, bytes: [0x1f, 0x8b] },
  { format: "ELF", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { format: "Mach-O", offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { format: "Mach-O", offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { format: "Mach-O", offset: 0, bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { format: "Mach-O", offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { format: "Mach-O", offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { format: "Mach-O", offset: 0, bytes: [0xbe, 0xba, 0xfe, 0xca] },
  { format: "wasm", offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d] },
  // ISO base media (mp4, m4a, mov): the brand box, not the file, starts at 0.
  { format: "mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];
export function binaryFormat(head: Uint8Array): string | null {
  for (const magic of BINARY_MAGIC) {
    if (head.length < magic.offset + magic.bytes.length) continue;
    let match = true;
    for (let i = 0; i < magic.bytes.length; i++)
      if (head[magic.offset + i] !== magic.bytes[i]) {
        match = false;
        break;
      }
    if (match) return magic.format;
  }
  return null;
}

// One blob's bytes, fed in whatever pieces the pipe delivers, matched a window
// at a time. One buffer per blob, sized to the blob and never larger than a
// window plus its overlap, so a 500 MB blob never lands in memory whole and a
// tree of small files does not allocate a megabyte per file.
class BlobSink {
  private readonly window: Buffer;
  // Never more than half the window, so a flush always leaves room for the next
  // bytes however small the blob (and so a blob that fits in one window, where
  // there is no boundary to straddle, never pays for one).
  private readonly overlap: number;
  private filled = 0;
  private decided = false;
  private stopped = false;
  private readonly found = new Set<string>();
  binary: string | null = null;
  constructor(
    private readonly scanBinary: boolean,
    size: number,
  ) {
    const capacity = Math.max(
      1,
      Math.min(size, SCAN_WINDOW_BYTES + SCAN_OVERLAP_BYTES),
    );
    this.window = Buffer.allocUnsafe(capacity);
    this.overlap = Math.min(SCAN_OVERLAP_BYTES, capacity >> 1);
  }
  // False once nothing more can be learned from this blob: it is a skipped
  // binary, or a pattern already matched. The feeder may then stop scanning (it
  // still has to drain the pipe).
  push(bytes: Uint8Array): boolean {
    let at = 0;
    while (!this.stopped && at < bytes.length) {
      const take = Math.min(
        this.window.length - this.filled,
        bytes.length - at,
      );
      this.window.set(bytes.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (!this.decided && this.filled >= MAGIC_BYTES) this.decide();
      if (!this.stopped && this.decided && this.filled >= this.window.length)
        this.flush();
    }
    return !this.stopped;
  }
  end(): string[] {
    if (!this.decided) this.decide();
    if (!this.stopped) this.flush();
    return [...this.found];
  }
  private decide() {
    this.decided = true;
    const format = binaryFormat(
      this.window.subarray(0, Math.min(this.filled, MAGIC_BYTES)),
    );
    if (!format || this.scanBinary) return;
    this.binary = format;
    this.stopped = true;
    this.filled = 0;
  }
  private flush() {
    if (this.filled === 0) return;
    for (const reason of secretReasonsInBytes(
      this.window.subarray(0, this.filled),
    ))
      this.found.add(reason);
    // One class named per blob is enough to refuse it; reading the rest of a file
    // that already failed buys nothing and costs the whole file.
    if (this.found.size > 0) {
      this.stopped = true;
      this.filled = 0;
      return;
    }
    // Keep the window's tail in front of the next one: a pattern that straddles
    // the boundary is then matched whole, exactly once.
    const keep = Math.min(this.overlap, this.filled);
    this.window.copyWithin(0, this.filled - keep, this.filled);
    this.filled = keep;
  }
}

function gitArgs(o: ScanCommitOptions): string[] {
  const args = ["--git-dir", resolve(o.gitDir)];
  if (o.workTree) args.push("--work-tree", resolve(o.workTree));
  return args;
}

export interface TreeBlob {
  path: string;
  mode: string;
  sha: string;
  size: number;
}
// What the commit contains, from the commit — not from `git status`, not from a
// diff, not from the working tree. `--long` carries the size, so a caller with a
// ceiling knows before reading which blobs cannot be finished.
export async function listCommitBlobs(
  o: ScanCommitOptions,
): Promise<TreeBlob[]> {
  const out = await runGit(
    o,
    ["ls-tree", "-r", "-z", "--long", o.commit],
    64_000_000,
  );
  const rows = out.toString("utf8").split("\0").filter(Boolean);
  const blobs: TreeBlob[] = [];
  for (const row of rows) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", sha = "", size = ""] = row
      .slice(0, tab)
      .trim()
      .split(/\s+/);
    // Submodules are `commit` entries: their bytes are not in this commit and
    // are not pushed with it.
    if (type !== "blob") continue;
    blobs.push({
      path: row.slice(tab + 1),
      mode,
      sha,
      size: Number.parseInt(size, 10) || 0,
    });
  }
  return blobs;
}

// The gate. Returns one entry per (path, pattern class) that matched, in tree
// order; an empty array means every blob in the commit was read and none of them
// matched. A blob that appears at several paths is read once and reported at
// each path.
export async function scanCommitForSecrets(
  o: ScanCommitOptions,
): Promise<SecretHit[]> {
  return (await scanCommit(o)).hits;
}
// The same pass, with what it could not examine. `hits` is exactly what
// scanCommitForSecrets returns; `unexamined` is every blob the gate stopped
// short of, so a caller can disclose that list instead of implying the whole
// commit was read.
export async function scanCommit(o: ScanCommitOptions): Promise<CommitScan> {
  const skip = new Set(o.skip ?? []);
  const only = o.only ? new Set(o.only) : null;
  const limit = Math.max(0, o.maxBlobBytes ?? 0);
  const blobs = (await listCommitBlobs(o)).filter(
    (b) => b.size > 0 && !skip.has(b.path) && (!only || only.has(b.path)),
  );
  // Identical content is read once however many paths hold it.
  const order: string[] = [];
  const sizes = new Map<string, number>();
  for (const b of blobs)
    if (!sizes.has(b.sha)) {
      sizes.set(b.sha, b.size);
      order.push(b.sha);
    }
  const truncated = new Set<string>();
  const found = new Map<string, string[]>();
  // sha → the binary format that stopped the scan of that blob.
  const binary = new Map<string, string>();
  const whole = order.filter((sha) => !limit || (sizes.get(sha) ?? 0) <= limit);
  const over = order.filter((sha) => limit && (sizes.get(sha) ?? 0) > limit);
  if (whole.length) await scanBatch(o, whole, found, binary);
  // Only reachable when the caller set a ceiling: read the first `limit` bytes
  // with the blob's own `git cat-file blob <sha>` and kill it there, so the rest
  // of a 500 MB blob is never even piped.
  for (const sha of over) {
    const head = await scanBlobHead(o, sha, limit);
    found.set(sha, head.reasons);
    if (head.binary) binary.set(sha, head.binary);
    truncated.add(sha);
  }
  const hits: SecretHit[] = [];
  const unexamined: UnexaminedBlob[] = [];
  for (const b of blobs) {
    for (const reason of found.get(b.sha) ?? [])
      hits.push({ path: b.path, reason });
    if (truncated.has(b.sha)) {
      hits.push({ path: b.path, reason: UNSCANNED_REASON });
      unexamined.push({
        path: b.path,
        reason: UNSCANNED_REASON,
        bytes: b.size,
      });
    } else {
      const format = binary.get(b.sha);
      if (format)
        unexamined.push({
          path: b.path,
          reason: binarySkipReason(format),
          bytes: b.size,
        });
    }
  }
  return { hits, unexamined, blobs: blobs.length };
}

// One `git cat-file --batch` for the whole commit. This is the batched spelling
// of `git cat-file blob <sha>` — same command, same raw bytes, same absence of
// filters — and it is what makes the gate affordable: measured on this
// repository (245 blobs), a spawn per blob costs 1510 ms and one batch costs
// 54 ms, and a real project with thousands of tracked files would pay ~6 ms of
// process start per file on every publish.
//
// The batch protocol is `<oid> SP <type> SP <size> LF <contents> LF`, so the
// bytes are framed by a length the gate never has to buffer: each blob's content
// is handed to its sink as it arrives.
async function scanBatch(
  o: ScanCommitOptions,
  shas: string[],
  found: Map<string, string[]>,
  binary: Map<string, string>,
) {
  const child = spawn("git", [...gitArgs(o), "cat-file", "--batch"], {
    cwd: o.workTree ? resolve(o.workTree) : undefined,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    if (stderr.length < 2000) stderr += b.toString("utf8");
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });
  const exit = new Promise<number | null>((res) =>
    child.on("close", (code) => res(code)),
  );
  child.stdin.on("error", () => {});
  child.stdin.end(shas.join("\n") + "\n");

  let state: "header" | "body" | "trailer" = "header";
  let header: Uint8Array[] = [];
  let remaining = 0;
  let sha = "";
  let sink: BlobSink | null = null;
  let scanning = true;
  let read = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let at = 0;
      while (at < chunk.length) {
        if (state === "header") {
          const lf = chunk.indexOf(0x0a, at);
          if (lf < 0) {
            header.push(chunk.subarray(at));
            break;
          }
          header.push(chunk.subarray(at, lf));
          at = lf + 1;
          const line = Buffer.concat(header).toString("utf8").trim();
          header = [];
          const [oid = "", type = "", size = ""] = line.split(" ");
          if (type !== "blob")
            throw new SecretGateError(
              `git cat-file could not read an object of the commit (${line.slice(0, 80)})`,
            );
          sha = oid;
          remaining = Number.parseInt(size, 10) || 0;
          sink = new BlobSink(o.scanBinary === true, remaining);
          scanning = true;
          state = remaining > 0 ? "body" : "trailer";
        } else if (state === "body") {
          const take = Math.min(remaining, chunk.length - at);
          if (scanning && sink)
            scanning = sink.push(chunk.subarray(at, at + take));
          at += take;
          remaining -= take;
          if (remaining === 0) state = "trailer";
        } else {
          at += 1; // the LF git writes after the contents
          if (sink) {
            const reasons = sink.end();
            if (reasons.length) found.set(sha, reasons);
            if (sink.binary) binary.set(sha, sink.binary);
            read++;
          }
          sink = null;
          state = "header";
        }
      }
    }
  } catch (e) {
    if (!timedOut) {
      // Leave nothing running behind a throw: the child would otherwise keep
      // reading the repository and the timer would hold the process open.
      clearTimeout(timer);
      child.kill("SIGKILL");
      throw e;
    }
  }
  const code = await exit;
  clearTimeout(timer);
  if (spawnError)
    throw new SecretGateError(
      `git cat-file could not be run: ${(spawnError as Error).message}`,
    );
  if (timedOut)
    throw new SecretGateError(
      "git cat-file timed out reading the commit's blobs; nothing was scanned to the end",
    );
  if (code !== 0)
    throw new SecretGateError(
      `git cat-file failed (${code}): ${stderr.trim().slice(0, 400)}`,
    );
  // Anything other than "between objects" means bytes of this commit were never
  // looked at, and a gate that returns [] then is the hole it exists to close.
  if (state !== "header" || header.length > 0 || read !== shas.length)
    throw new SecretGateError(
      `git cat-file returned ${read} of the commit's ${shas.length} blobs; the commit was not scanned to the end`,
    );
}

// The first `limit` bytes of one blob, with the command stopped as soon as they
// arrive. Used only for blobs a caller's ceiling puts out of reach.
async function scanBlobHead(
  o: ScanCommitOptions,
  sha: string,
  limit: number,
): Promise<{ reasons: string[]; binary: string | null }> {
  const child = spawn("git", [...gitArgs(o), "cat-file", "blob", sha], {
    cwd: o.workTree ? resolve(o.workTree) : undefined,
    env: o.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    if (stderr.length < 2000) stderr += b.toString("utf8");
  });
  const exit = new Promise<number | null>((res) =>
    child.on("close", (code) => res(code)),
  );
  child.on("error", () => {});
  const sink = new BlobSink(o.scanBinary === true, limit);
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let read = 0;
  // True once the gate stopped the command on purpose, which is how this
  // function normally ends: the exit code after our own SIGKILL means nothing.
  let stopped = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      const take = Math.min(chunk.length, limit - read);
      read += take;
      const more = sink.push(chunk.subarray(0, take));
      if (!more || read >= limit) {
        stopped = true;
        child.kill("SIGKILL");
        break;
      }
    }
  } catch (e) {
    if (!stopped) {
      clearTimeout(timer);
      child.kill("SIGKILL");
      throw new SecretGateError(
        `git cat-file blob could not be read: ${(e as Error).message}`,
      );
    }
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
  // Ending early on our own terms is expected. Ending any other way means the
  // blob was not read, and [] would then be a clean answer about unread bytes.
  if (!stopped) {
    const code = await exit;
    if (code !== 0)
      throw new SecretGateError(
        `git cat-file blob failed (${code}): ${stderr.trim().slice(0, 400)}`,
      );
  }
  const reasons = sink.end();
  return { reasons, binary: sink.binary };
}

async function runGit(
  o: ScanCommitOptions,
  args: string[],
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((res, rej) => {
    const child = spawn("git", [...gitArgs(o), ...args], {
      cwd: o.workTree ? resolve(o.workTree) : undefined,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        rej(
          new SecretGateError(
            `git ${args[0]} produced more than ${maxBytes} bytes`,
          ),
        );
        return;
      }
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 2000) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(new SecretGateError(`git ${args[0]} could not be run: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(Buffer.concat(out));
      else
        rej(
          new SecretGateError(
            `git ${args[0]} failed (${code}): ${stderr.trim().slice(0, 400)}`,
          ),
        );
    });
  });
}
