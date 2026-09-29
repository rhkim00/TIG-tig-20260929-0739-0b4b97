// Shared conservative upload validation. A scanner reduces accidental disclosure;
// it is not a proof that arbitrary project code contains no secrets.
export function safePath(path: string): boolean {
  const pieces = path.split("/");
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.includes(":") &&
    !pieces.some(
      (p) => p === "" || p === "." || p === ".." || p.startsWith("."),
    ) &&
    !pieces.some((p) =>
      /^(node_modules|credentials|secrets|id_rsa|id_ed25519|auth\.json)$/i.test(
        p,
      ),
    ) &&
    !/\.(pem|key|p12|pfx|keystore|log)$/i.test(path)
  );
}
// Whole-tree publication (request branch, worker result) allows dot-files that a
// project needs (.gitignore, .github, .eslintrc) and blocks only what must never
// leave the machine. The reason is shown to the user next to the path.
const PROTECTED_SEGMENTS = new Set([
  ".envrc",
  ".mcp.json",
  ".codex",
  ".aws",
  ".ssh",
  ".kube",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".htpasswd",
  "credentials",
  "secrets",
  "auth.json",
  "kubeconfig",
]);
const DEPENDENCY_SEGMENTS = new Set([
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
]);
const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);
export function protectedPathReason(path: string): string | null {
  if (
    !path.length ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":")
  )
    return "protected";
  const pieces = path.split("/");
  if (pieces.some((p) => p === "" || p === "." || p === ".."))
    return "protected";
  const lower = pieces.map((p) => p.toLowerCase());
  if (lower.includes(".git")) return "git metadata";
  if (lower[0] === ".github" && lower[1] === "workflows") return "CI would run";
  if (lower.some((p) => DEPENDENCY_SEGMENTS.has(p))) return "dependencies";
  if (lower.slice(0, -1).some((p) => PROTECTED_SEGMENTS.has(p)))
    return "protected";
  const name = lower[lower.length - 1];
  const parent = lower[lower.length - 2] ?? "";
  if (
    PROTECTED_SEGMENTS.has(name) ||
    name === ".env" ||
    (name.startsWith(".env.") && !ENV_EXAMPLES.has(name)) ||
    (parent === ".claude" &&
      (name === "settings.local.json" || name === ".credentials.json")) ||
    (parent === ".docker" && name === "config.json") ||
    name.startsWith("id_rsa") ||
    name.startsWith("id_ed25519") ||
    name.startsWith("secrets.") ||
    name.endsWith(".secret") ||
    name.endsWith(".tfstate.backup") ||
    /\.(pem|key|p12|pfx|keystore|jks|tfstate|tfvars|log)$/.test(name)
  )
    return "protected";
  return null;
}
export function protectedPath(path: string): boolean {
  return protectedPathReason(path) !== null;
}
// The one table of secret shapes. It is the four regexes containsSecret used to
// inline, split at their top-level alternations so a match can be named without
// quoting it: `A|B` tests the same as `A` or `B`, so containsSecret's answer for
// every input is unchanged, and each branch keeps the flags of the regex it came
// from (`i` everywhere, `m` where a `^` anchors a line).
// The reason is a class name, never the matched text: a caller may print it, log
// it or send it to the platform, and the secret itself must never travel.
export interface SecretPattern {
  readonly reason: string;
  readonly re: RegExp;
}
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    reason: "private key header",
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  },
  { reason: "OpenAI-style key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/i },
  {
    reason: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  },
  { reason: "AWS access key id", re: /\bAKIA[A-Z0-9]{16}\b/i },
  {
    reason: "key assignment",
    re: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9+/_-]{12,}/i,
  },
  {
    reason: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/im,
  },
  {
    reason: "npm auth token",
    re: /_authToken\s*=\s*\S{12,}|\bnpm_[A-Za-z0-9]{30,}/im,
  },
  { reason: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/im },
  { reason: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/im },
  // .netrc password lines.
  { reason: "netrc password", re: /^\s*machine\s+\S+.*\bpassword\s+\S{6,}/im },
  // Quoted keys as JSON/YAML/TOML write them: "token": "…", secret = '…'.
  {
    reason: "quoted secret assignment",
    re: /["']?(?:api_?key|secret|token|password)["']?\s*[:=]\s*["'][^"'\n]{12,}["']/i,
  },
];
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.re.test(text));
}
// Which classes matched, in table order, for a caller that reports rather than
// only refuses. Never the matched text.
export function secretReasons(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.reason);
}

// Every pattern above is plain ASCII, so finding one needs no successful UTF-8
// decode — it needs the bytes. Mapping each byte to the code point of the same
// value (latin1) leaves every ASCII byte exactly where it is and turns every
// other byte into a non-word, non-newline character, so the patterns match in a
// CP949, Shift-JIS, latin1 or half-truncated-UTF-8 file the way they match in a
// UTF-8 one. `\b`, `\s` and `.` are ASCII-only in JS regexes, so the class of a
// neighbouring byte does not change.
const latin1 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined")
    return (
      Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    ).toString("latin1");
  return new TextDecoder("latin1").decode(bytes);
};
// UTF-16 and UTF-32 store ASCII as the character interleaved with NUL bytes
// ("A\0K\0I\0A\0" or "\0\0\0A"), in either byte order. Dropping every NUL turns
// all four of those back into the ASCII the patterns are written for, without
// guessing an encoding or a BOM. It also runs over binary blobs, where it can
// join unrelated bytes into a match — that costs a refused publish, never a
// missed secret, which is the right way round for a gate.
const stripNuls = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] !== 0) out[n++] = bytes[i];
  return out.subarray(0, n);
};
// The bytes entry point: same patterns, same reason vocabulary, no decode
// required. Callers scan what is about to be published, not a decoded copy of it.
export function secretReasonsInBytes(bytes: Uint8Array): string[] {
  const reasons = secretReasons(latin1(bytes));
  if (!bytes.includes(0)) return reasons;
  const seen = new Set(reasons);
  for (const reason of secretReasons(latin1(stripNuls(bytes))))
    if (!seen.has(reason)) {
      seen.add(reason);
      reasons.push(reason);
    }
  return reasons;
}
export function containsSecretBytes(bytes: Uint8Array): boolean {
  return secretReasonsInBytes(bytes).length > 0;
}
