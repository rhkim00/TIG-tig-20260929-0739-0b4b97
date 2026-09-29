import { test } from "node:test";
import assert from "node:assert/strict";
import {
  environmentReport,
  renderDoctor,
  olderThan,
  semver,
  type DoctorServices,
} from "../apps/cli/src/doctor.js";
import { ApiError } from "../apps/cli/src/client.js";

const isolation = {
  available: true,
  executionEnabled: false,
  reason: "probe passed",
};
function services(overrides: Partial<DoctorServices> = {}): DoctorServices {
  return {
    nodeVersion: "v24.20.0",
    findExecutable: async (name) => `/usr/bin/${name}`,
    version: async (binary) =>
      binary.endsWith("gh")
        ? "gh version 2.100.0 (2026-09-03)"
        : binary.endsWith("git")
          ? "git version 2.43.0"
          : binary.endsWith("claude")
            ? "2.1.267 (Claude Code)"
            : "codex-cli 0.120.0",
    ghAuth: async () => ({ login: "worker-account" }),
    claudeReadiness: async () => {},
    codexReadiness: async () => {},
    loadConnection: async () => ({ origin: "https://tig.example.invalid" }),
    me: async () => ({ login: "worker-account" }),
    isolation: async () => isolation,
    ...overrides,
  };
}
const check = (
  report: Awaited<ReturnType<typeof environmentReport>>,
  id: string,
) => report.checks.find((c) => c.id === id)!;

test("a fully prepared computer is ready and every row reports what was found", async () => {
  const report = await environmentReport(services());
  assert.equal(report.ready, true);
  assert.deepEqual(
    report.checks.map((c) => [c.id, c.status]),
    [
      ["node", "ok"],
      ["git", "ok"],
      ["gh", "ok"],
      ["claude", "ok"],
      ["codex", "ok"],
      ["tokenisgold", "ok"],
    ],
  );
  assert.equal(
    check(report, "gh").detail,
    "2.100.0, signed in as worker-account",
  );
  assert.equal(
    check(report, "tokenisgold").detail,
    "https://tig.example.invalid as worker-account",
  );
  const text = renderDoctor(report);
  assert.match(text, /✓ GitHub CLI {3}2\.100\.0, signed in as worker-account/);
  assert.match(text, /Ready\. Run tig to post a request/);
  assert.doesNotMatch(text, /→/);
});

test("one signed-in local AI tool is enough; the other is informational", async () => {
  const report = await environmentReport(
    services({
      findExecutable: async (name) =>
        name === "codex" ? null : `/usr/bin/${name}`,
    }),
  );
  assert.equal(report.ready, true);
  assert.equal(check(report, "codex").status, "missing");
  assert.equal(check(report, "codex").optional, true);
  assert.match(renderDoctor(report), /· Codex {8}not installed/);

  const neither = await environmentReport(
    services({
      findExecutable: async (name) =>
        name === "codex" ? null : `/usr/bin/${name}`,
      claudeReadiness: async () => {
        throw new Error(
          "Sign in to Claude Code with your Claude subscription (claude auth login).",
        );
      },
    }),
  );
  assert.equal(neither.ready, false);
  assert.equal(check(neither, "claude").status, "signed_out");
  assert.equal(check(neither, "claude").fix, "claude auth login");
  assert.equal(check(neither, "codex").optional, false);
  assert.match(
    renderDoctor(neither),
    /✗ Claude Code {2}2\.1\.267, not signed in[^\n]*\n {6}→ claude auth login/,
  );
});

test("outdated tools name the exact fix: node major, gh minimum, claude update", async () => {
  const report = await environmentReport(
    services({
      nodeVersion: "v22.1.0",
      version: async (binary) =>
        binary.endsWith("gh") ? "gh version 2.4.0 (2021-12-21)" : "1.0.0",
      claudeReadiness: async () => {
        throw new Error(
          "Update Claude Code: this version does not support TIG's controlled drafting options.",
        );
      },
    }),
  );
  assert.equal(report.ready, false);
  assert.equal(check(report, "node").status, "outdated");
  assert.match(check(report, "node").fix!, /nvm install 24/);
  assert.equal(check(report, "gh").status, "outdated");
  assert.equal(check(report, "gh").detail, "2.4.0, tig needs 2.21.0 or newer");
  assert.equal(check(report, "claude").status, "outdated");
  assert.equal(check(report, "claude").fix, "claude update");
  assert.equal(check(report, "codex").status, "ok");
  assert.match(renderDoctor(report), /Fix the items marked ✗/);
});

test("GitHub CLI and Tokenisgold sign-in states map to reconnect commands", async () => {
  const signedOut = await environmentReport(
    services({
      ghAuth: async () => null,
      me: async () => {
        throw new ApiError(401, "AUTH_REQUIRED: Sign in again.");
      },
    }),
  );
  assert.equal(check(signedOut, "gh").status, "signed_out");
  assert.equal(check(signedOut, "gh").fix, "gh auth login");
  assert.equal(check(signedOut, "tokenisgold").status, "signed_out");
  assert.equal(
    check(signedOut, "tokenisgold").fix,
    "tig connect --origin https://tig.example.invalid",
  );

  const unreachable = await environmentReport(
    services({
      me: async () => {
        throw new Error("Cannot reach https://tig.example.invalid.");
      },
    }),
  );
  assert.equal(check(unreachable, "tokenisgold").status, "unreachable");
  assert.match(
    check(unreachable, "tokenisgold").detail,
    /cannot reach the website/,
  );

  const fresh = await environmentReport(
    services({
      loadConnection: async () => {
        throw new Error("Connect this device first");
      },
    }),
  );
  assert.equal(check(fresh, "tokenisgold").status, "missing");
  assert.equal(
    check(fresh, "tokenisgold").fix,
    "tig connect --origin <website>",
  );
  assert.equal(fresh.ready, false);
});

test("version helpers parse tool banners and compare numerically", () => {
  assert.equal(
    semver(
      "gh version 2.100.0 (2026-09-03)\nhttps://github.com/cli/cli/releases/tag/v2.100.0",
    ),
    "2.100.0",
  );
  assert.equal(semver("2.1.267 (Claude Code)"), "2.1.267");
  assert.equal(semver(null), null);
  assert.equal(olderThan("2.4.0", "2.21.0"), true);
  assert.equal(olderThan("2.100.0", "2.21.0"), false);
  assert.equal(olderThan("2.21.0", "2.21.0"), false);
});
