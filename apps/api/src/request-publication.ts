import { createHash } from "node:crypto";
import {
  type Tx,
  DomainError,
  canonical,
} from "../../../packages/db/src/index.js";
import {
  artifactSchema,
  type TaskSpec,
} from "../../../packages/contracts/src/index.js";
import {
  requestEnvelope,
  renderRequest,
  requestTaskFields,
  requestLayout,
} from "../../../packages/contracts/src/request.js";
import type { GitHub, TreeEntry } from "./github.js";
export const REQUEST_DOCUMENTS = ["request.md", "request.json"] as const;
export const gitBlobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
// Read the layout the requester recorded without re-validating the whole envelope;
// absent/unparseable means the pre-layout bundle contract.
export function artifactLayout(
  files: { path: string; content: string }[] | null | undefined,
): "bundle" | "tree" {
  const structured = files?.find((f) => f.path === "request.json");
  if (!structured) return "bundle";
  try {
    const layout = JSON.parse(structured.content)?.layout;
    return layout === "tree" ? "tree" : "bundle";
  } catch {
    return "bundle";
  }
}
function unavailable() {
  return new DomainError(
    "GIT_VERIFICATION_UNAVAILABLE",
    "Git request verification is unavailable. Retry the same prepared request later.",
    503,
  );
}
function blobMatches(entry: TreeEntry | undefined, content: string) {
  return (
    !!entry &&
    entry.type === "blob" &&
    entry.mode === "100644" &&
    entry.sha === gitBlobSha(content)
  );
}
export async function verifyGitRequest(
  tx: Tx,
  user: string,
  spec: TaskSpec,
  repository: string,
  github: GitHub,
) {
  const fail = () =>
    new DomainError(
      "REQUEST_PACKAGE_MISMATCH",
      "The Git request, task specification and uploaded code must match exactly.",
      409,
    );
  const row = (
    await tx.query("SELECT * FROM artifacts WHERE id=$1 AND user_id=$2", [
      spec.handoffArtifactId,
      user,
    ])
  ).rows[0];
  if (!row || !spec.gitRequest || spec.gitRequest.repository !== repository)
    throw fail();
  const artifact = artifactSchema.parse({
    baseCommit: row.base_commit,
    summary: row.summary,
    manifestHash: row.manifest_hash,
    files: row.files,
    deletedPaths: row.deleted_paths,
  });
  const document = artifact.files.find((f) => f.path === "request.md"),
    structured = artifact.files.find((f) => f.path === "request.json");
  if (!document || !structured || artifact.deletedPaths.length) throw fail();
  let envelope;
  try {
    envelope = requestEnvelope.parse(JSON.parse(structured.content));
  } catch {
    throw fail();
  }
  if (
    envelope.repository !== repository ||
    envelope.sourceCommit !== spec.gitRequest.sourceCommit ||
    !["main", `tig/requests/${envelope.id}`].includes(spec.gitRequest.branch) ||
    document.content !== renderRequest(envelope) ||
    artifact.summary !== envelope.request.context ||
    artifact.baseCommit !== spec.baseCommit ||
    artifact.manifestHash !== spec.packageManifestHash ||
    canonical(requestTaskFields(envelope.request)) !==
      canonical(requestTaskFields({ ...envelope.request, ...spec })) ||
    spec.commandApproval.text !== envelope.request.originalRequest
  )
    throw fail();
  if (requestLayout(envelope) === "tree") {
    // Tree layout: the branch root is the whole working tree, which the server
    // does not mirror. The artifact carries only the two documents, and only
    // those root blobs are compared (parentless commit still required).
    if (artifact.files.length !== 2) throw fail();
    if (!github.requestRoot) throw unavailable();
    const root = await github.requestRoot(repository, spec.baseCommit);
    for (const doc of [document, structured])
      if (
        !blobMatches(
          root.find((f) => f.path === doc.path),
          doc.content,
        )
      )
        throw fail();
    return;
  }
  // Bundle layout: code/ may be empty (a new-project request publishes only the
  // two documents), and the recursive tree must equal the artifact exactly.
  if (
    artifact.files.some(
      (f) =>
        !(REQUEST_DOCUMENTS as readonly string[]).includes(f.path) &&
        !f.path.startsWith("code/"),
    )
  )
    throw fail();
  if (!github.requestTree) throw unavailable();
  const tree = await github.requestTree(repository, spec.baseCommit);
  const files = tree.filter((f) => f.type !== "tree");
  const expected = new Map(artifact.files.map((f) => [f.path, f.content]));
  if (
    files.length !== expected.size ||
    new Set(files.map((f) => f.path)).size !== expected.size
  )
    throw fail();
  for (const f of files)
    if (!expected.has(f.path) || !blobMatches(f, expected.get(f.path)!))
      throw fail();
}
