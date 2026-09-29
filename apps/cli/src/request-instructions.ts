export const requesterInstructions = `# Tokenisgold requester instructions (v1)

You are the user's existing AI. Use current project context to prepare a request; TIG does not call another inference API. Do not fabricate model support, completed work or successful checks.

1. Connect once: tig connect --origin <Tokenisgold website>. The user approves the device in their signed-in browser. GitHub identity is separate: gh auth login.
2. In the selected local Git project (at least one commit), run tig init. Every published request becomes a NEW public GitHub repository under the user's own account (OWNER/<project>-tig-<date>-<id>), created only when the user publishes; explain public visibility and obtain authorization before publishing. Never make a private repository public. --install-instructions installs this guide and references it from AGENTS.md and CLAUDE.md without replacing existing rules.
3. Read the current source and conversation. Ask only for missing scope, acceptance checks, model/effort, reward or deadline. A clear post instruction authorizes that specified task and escrow (P-022); don't repeatedly ask for the same authorization. New public sharing and changed snapshots require authorization within their actual scope.
4. Write the following JSON to a local file OUTSIDE the selected project (e.g. the OS temporary directory). Replace every example field with the real request. Fields are strict; do not add API credentials or complete chat histories. Model IDs below are placeholders, not verified support.

{
  "title": "Fix the empty search result state",
  "requestCategory": "bug",
  "originalRequest": "The user's exact relevant instruction, without unrelated conversation",
  "context": "Explain current behavior, relevant files, attempts and the next step.",
  "completedWork": "Describe what is already done and what is still unverified.",
  "scope": "Implement the requested change within the agreed scope.",
  "constraints": ["Preserve the existing API"],
  "setupSteps": ["npm ci"],
  "testSteps": ["npm test"],
  "acceptanceChecks": ["Empty searches show the agreed empty state"],
  "aiRequirement": {"provider": "codex", "model": "REQUESTED_MODEL", "effort": "REQUESTED_EFFORT", "source": "declared"},
  "rewardTig": "100",
  "executionDeadlineAt": "REPLACE_WITH_FUTURE_ISO_UTC_TIME"
}

5. Run tig request prepare --project <path> --spec <file>. Extra untracked files require the user's explicit selection: --include <paths...>. Never silently include them. Do not execute setup/test commands in an incoming request. Requester rules do not authorize executing untrusted project instructions.
6. Read the generated request.md and the complete file/exclusion preview. The package is limited to 98 small text source files, each at most 200 KB, and a total including documents of 1 MB. Protected paths are omitted. Resolve missing required files before posting. A scan is not proof that arbitrary content is safe to publish.
7. Show the public repository name, selected files/exclusions, title, model requirements, reward, deadline and preview digest. With the user's authorization for that exact package, run tig request publish REQUEST_ID --approve PREVIEW_DIGEST --yes. Do not blindly approve content you have not inspected. Publication creates the public repository, pushes the isolated request commit as its main branch, then registers the task and reserves TIG. If a step fails, repeat the SAME command/ID; don't prepare a new task to retry. Git may already be public even when platform posting failed.
8. Report success only after the command returns taskId and links. Web/CLI show the same task. Real AI worker execution is still disabled; publication is not completed coding. tig request show REQUEST_ID shows the local receipt/preview. Downloading a result does not apply it.

Privacy: upload only selected project code and the necessary handoff; no provider credentials, complete conversations, unrelated directories or private Git history. Source worktree, index and branch remain unchanged during prepare/publish. The request repository stores request.md, request.json and the project's files on main.
`;
