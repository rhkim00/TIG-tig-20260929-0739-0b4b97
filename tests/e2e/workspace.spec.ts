import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { manifest } from "../../apps/api/src/domain.js";
async function navigate(page: Page, name: string) {
  if (await page.getByRole("button", { name: "Toggle navigation" }).isVisible())
    await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
test("new local user can connect a project, post a handoff, see escrow, cancel and change privacy settings", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/__test/reset");
  await page.goto("/");
  await page.getByRole("button", { name: "Explore local preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next idea starts here." }),
  ).toBeVisible();
  await expect(
    page.locator(".balance").filter({ hasText: "3,000" }),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/overview-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await navigate(page, "Connections");
  await page
    .getByLabel("Public GitHub repository")
    .fill(`example/${info.project.name}`);
  await page
    .getByRole("button", { name: "Connect project", exact: true })
    .click();
  await expect(
    page.getByText(`example/${info.project.name}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Post a task", exact: true }).click();
  const artifact = {
    baseCommit: "a".repeat(40),
    summary:
      "Create an accessible search shortcut and preserve existing navigation.",
    files: [],
    manifestHash: manifest([]),
  };
  await page.getByLabel("Import handoff").setInputFiles({
    name: "handoff.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption({ label: `example/${info.project.name}` });
  await page
    .getByLabel("What needs to be done?")
    .fill(`Search shortcut ${info.project.name}`);
  await page
    .getByLabel("How will we know it is done?")
    .fill("Keyboard shortcut opens and closes search");
  await page.getByLabel("Model", { exact: true }).fill("requested-model");
  await page.getByLabel("Reasoning level").fill("requested-effort");
  await page.getByRole("button", { name: "Post task · 1,000 TIG" }).click();
  await expect(page.getByRole("status")).toContainText("Your task is live");
  await expect(
    page.getByText(`Search shortcut ${info.project.name}`, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await navigate(page, "Overview");
  await expect(
    page.locator(".balance").filter({ hasText: "2,000" }),
  ).toBeVisible();
  await expect(
    page.locator(".stat-number").filter({ hasText: "1,000" }),
  ).toBeVisible();
  await navigate(page, "My tasks");
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your TIG has been restored",
  );
  await navigate(page, "Activity");
  await expect(
    page.getByText("Task refunded", { exact: true }).first(),
  ).toBeVisible();
  await navigate(page, "Settings");
  const optional = page.getByRole("switch", {
    name: "Optional product analytics",
  });
  await expect(optional).not.toBeChecked();
  await optional.check();
  await expect(page.getByRole("status")).toContainText(
    "Privacy preference saved",
  );
  await page.reload();
  await navigate(page, "Settings");
  await expect(optional).toBeChecked();
  await optional.uncheck();
  expect(errors).toEqual([]);
});

test("two browser accounts complete a checked result and pay or refund the reward", async ({
  browser,
  page,
}, info) => {
  await page.request.post("/__test/reset");
  await page.goto("/");
  await page.getByRole("button", { name: "Explore local preview" }).click();
  await page.getByRole("button", { name: "Post local test · 100 TIG" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const workerContext = await browser.newContext({
    viewport:
      info.project.name === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
  });
  const worker = await workerContext.newPage();
  try {
    await worker.goto("http://127.0.0.1:4175/");
    await worker
      .getByRole("button", { name: "Switch preview account" })
      .click();
    await expect(worker.locator(".dev-banner")).toContainText("demo-worker");
    await navigate(worker, "Marketplace");
    await worker
      .getByText("Update wallet labels · local test", { exact: true })
      .click();
    await worker.getByRole("button", { name: "Yes, accept this task" }).click();
    await worker.getByRole("button", { name: "Start local test" }).click();
    const result = worker.getByRole("textbox", { name: "Result file" });
    const good = await result.inputValue();
    await result.fill('{"wrong":"result"}');
    await worker
      .getByRole("button", { name: "Submit result", exact: true })
      .click();
    await expect(worker.getByRole("dialog").getByRole("alert")).toContainText(
      "Required check failed",
    );
    await result.fill(good);
    await worker
      .getByRole("button", { name: "Submit result", exact: true })
      .click();
    await expect(
      worker.getByRole("heading", { name: "Submitted result" }),
    ).toBeVisible();
    await page.reload();
    await navigate(page, "Inbox");
    const update = page
      .locator(".notification-row")
      .filter({ hasText: "Your result is ready" });
    await expect(update).toBeVisible({ timeout: 15000 });
    await update.getByRole("button", { name: "Open task" }).click();
    await expect(
      page.getByText("Required check: passed", { exact: false }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download result", exact: true })
      .click();
    const download = await downloadPromise;
    const downloaded = JSON.parse(
      await readFile((await download.path())!, "utf8"),
    );
    expect(downloaded.artifact.files[0].path).toBe("wallet-labels.json");
    expect(downloaded.execution.providerVerified).toBe(false);
    await page.screenshot({
      path: `.local/screenshots/review-${info.project.name}.png`,
      fullPage: true,
    });
    const refund = info.project.name === "mobile";
    await page
      .getByRole("button", {
        name: refund ? "Report an issue & refund" : "Approve & pay 100 TIG",
      })
      .click();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText(
      refund ? "All TIG restored" : "Reward paid",
    );
    await page.getByRole("button", { name: "Close dialog" }).click();
    await navigate(page, "Overview");
    await expect(page.locator(".balance")).toContainText(
      refund ? "3,000" : "2,900",
    );
    await navigate(page, "Insights");
    await page
      .getByRole("checkbox", { name: "Show live sample activity" })
      .check();
    await expect(
      page.getByRole("meter", { name: "Features requests" }),
    ).toHaveAttribute("value", "1");
    await expect(page.locator(".outcome-list")).toContainText(
      "Direct approvals",
    );
    await expect(
      page
        .locator(".outcome-list>div")
        .filter({ hasText: refund ? "Refunds" : "Direct approvals" })
        .locator("dd"),
    ).toHaveText("1");
    await page.screenshot({
      path: `.local/screenshots/insights-${info.project.name}.png`,
      fullPage: true,
    });
    await worker.reload();
    await navigate(worker, "Overview");
    await expect(worker.locator(".balance")).toContainText(
      refund ? "1,600" : "1,700",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await workerContext.close();
  }
});

test("requester Git publication link opens the exact request after navigation and reload", async ({
  page,
}, info) => {
  const { randomUUID, createHash } = await import("node:crypto");
  const { renderRequest, requestTaskFields, requestEnvelope } =
    await import("../../packages/contracts/src/request.js");
  await page.request.post("/__test/reset");
  expect((await page.request.get("/__test/rate-probe")).status()).toBe(200);
  expect((await page.request.get("/__test/rate-probe")).status()).toBe(200);
  expect((await page.request.get("/__test/rate-probe")).status()).toBe(429);
  await page.request.post("/__test/reset");
  expect((await page.request.get("/__test/rate-probe")).status()).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: "Explore local preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next idea starts here." }),
  ).toBeVisible();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, {
      headers: {
        origin: "http://127.0.0.1:4175",
        "idempotency-key": randomUUID(),
      },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const repository = `example/request-${info.project.name}`;
  const project = await post("/v1/projects", {
    repository,
    projectType: "software",
    stack: [],
  });
  const envelope = requestEnvelope.parse({
    version: 1,
    id: randomUUID(),
    repository,
    sourceCommit: "a".repeat(40),
    request: {
      title: "Fix addition from my terminal",
      requestCategory: "bug",
      originalRequest: "Post this addition fix for 100 TIG",
      context: "The addition function currently subtracts its second argument.",
      completedWork: "A reproduction is ready; the code is not yet fixed.",
      scope:
        "Fix the addition function and verify positive and negative numbers.",
      constraints: [],
      setupSteps: ["Use Node 24"],
      testSteps: ["node --test"],
      acceptanceChecks: ["Adding 2 and 3 returns 5"],
      aiRequirement: {
        provider: "codex",
        model: "requested-model",
        effort: "requested-effort",
        source: "declared",
      },
      rewardTig: "100",
      executionDeadlineAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const files = [
    { path: "request.md", content: renderRequest(envelope) },
    { path: "request.json", content: JSON.stringify(envelope) },
    { path: "code/math.js", content: "exports.add=(a,b)=>a-b;" },
  ].map((f) => ({
    ...f,
    sha256: createHash("sha256").update(f.content).digest("hex"),
    source: "tracked",
  }));
  const commit = "c".repeat(40);
  await post("/__test/request-tree", {
    commit,
    tree: files.map((f) => ({
      path: f.path,
      type: "blob",
      mode: "100644",
      sha: createHash("sha1")
        .update(`blob ${Buffer.byteLength(f.content)}\0`)
        .update(f.content)
        .digest("hex"),
    })),
  });
  const artifact = await post("/v1/artifacts", {
    baseCommit: commit,
    summary: envelope.request.context,
    files,
    manifestHash: manifest(files),
  });
  const task = await post("/v1/tasks", {
    ...requestTaskFields(envelope.request),
    projectId: project.id,
    baseCommit: commit,
    handoffArtifactId: artifact.id,
    packageManifestHash: manifest(files),
    gitRequest: {
      repository,
      branch: `tig/requests/${envelope.id}`,
      sourceCommit: envelope.sourceCommit,
      requestPath: "request.md",
    },
    commandApproval: {
      kind: "explicit_post",
      text: envelope.request.originalRequest,
    },
  });
  await page.goto(`/?task=${task.id}`);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: envelope.request.title }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "View request.md & code on GitHub" }),
  ).toHaveAttribute(
    "href",
    `https://github.com/${repository}/blob/${commit}/request.md`,
  );
  await expect(
    dialog.getByText("Real AI execution is pending runner verification."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: envelope.request.title }),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/requester-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
