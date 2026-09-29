import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Check,
  Copy,
  Terminal,
  LayoutDashboard,
  Compass,
  Layers,
  Link2,
  Settings,
  History,
  ChevronRight,
  GitBranch,
  Clock,
  X,
  AlertCircle,
  RefreshCw,
  LogOut,
  Menu,
  Coins,
  Code2,
  ShieldCheck,
  Search,
  FileText,
  Bell,
  BarChart3,
} from "lucide-react";
import { dashboard, request, ApiError, type Dashboard } from "./api.js";
import {
  artifactSchema,
  type TaskView,
} from "../../../packages/contracts/src/index.js";
import "./style.css";
import { TaskTransaction } from "./TaskTransaction.js";
import { InboxPanel } from "./InboxPanel.js";
import { InsightsPanel } from "./InsightsPanel.js";
const pages = [
  ["Overview", LayoutDashboard],
  ["Marketplace", Compass],
  ["My tasks", Layers],
  ["Connections", Link2],
  ["Activity", History],
  ["Inbox", Bell],
  ["Insights", BarChart3],
  ["Settings", Settings],
] as const;
type Page = (typeof pages)[number][0];
const number = (value: string) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    Number(value),
  );
const date = (s: string) =>
  new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const friendly = (s: string) => s.replaceAll("_", " ").toLowerCase();
function App() {
  const [page, setPage] = useState<Page>("Overview"),
    [data, setData] = useState<Dashboard | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [modal, setModal] = useState<"post" | "pair" | null>(null),
    [menu, setMenu] = useState(false),
    [detail, setDetail] = useState<TaskView | null>(null),
    [config, setConfig] = useState<{
      development: boolean;
      githubSignIn: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const result = await dashboard();
      if (mounted.current) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && e.status === 401) setData(null);
        else setError((e as Error).message);
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void request("/v1/config")
      .then(setConfig)
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (data && query.has("connect")) setModal("pair");
    else if (data && /^[a-f0-9-]{36}$/.test(query.get("task") ?? "")) {
      const id = query.get("task")!;
      void request(`/v1/tasks/${id}`)
        .then((task) => setDetail(task))
        .catch((e) => setError(e.message));
    }
  }, [data?.me.id]);
  async function action(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function go(next: Page) {
    setPage(next);
    setMenu(false);
    setDetail(null);
  }
  const active =
    data?.tasks.filter((t) => !["PAID", "REFUNDED"].includes(t.state)) ?? [];
  const market =
    data?.market.filter(
      (t) =>
        t.requesterId !== data.me.id &&
        `${t.title} ${t.requestCategory}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="app">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a className="brand" href="/" aria-label="Tokenisgold home">
          <span className="brand-icon">
            t<span>g</span>
          </span>
          <span>
            tokenisgold<span className="beta">BETA</span>
          </span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {pages.map(([name, Icon]) => (
            <button
              key={name}
              className={page === name ? "nav active" : "nav"}
              onClick={() => go(name)}
              aria-label={name}
              aria-current={page === name ? "page" : undefined}
            >
              <Icon size={18} />
              {name}
              {name === "Inbox" && (data?.unreadCount ?? 0) > 0 && (
                <span
                  className="nav-count"
                  aria-label={`${data!.unreadCount} unread notifications`}
                >
                  {data!.unreadCount}
                </span>
              )}
              {name === "My tasks" && active.length > 0 && (
                <span className="nav-count">{active.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="small-note">
            <div className="mini-mark">✦</div>
            <strong>
              A little spare usage.
              <br />A lot of possibility.
            </strong>
            <p>Help someone build their next thing.</p>
            <button className="text-link" onClick={() => go("Marketplace")}>
              Explore tasks <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="user-row">
            <span className="avatar">
              {data?.me.login.slice(0, 1).toUpperCase() ?? "T"}
            </span>
            <div>
              <strong>{data?.me.login ?? "Your next chapter"}</strong>
              <small>
                {data ? "Personal workspace" : "Start with your GitHub"}
              </small>
            </div>
            {data && (
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={() =>
                  void action(
                    () => request("/v1/auth/logout", {}),
                    "Signed out.",
                  )
                }
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              onClick={() => setMenu(!menu)}
              aria-label="Toggle navigation"
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">Workspace</span>
            <ChevronRight size={14} />
            <span>{page}</span>
          </div>
          <span className="beta-note">
            <span className="status-dot" /> Build together.
          </span>
        </header>
        {config?.development && (
          <div className="dev-banner">
            Local preview · {data?.me.login ?? "Not signed in"} · Sample TIG. No
            AI execution.
            <button
              onClick={() =>
                void action(
                  () =>
                    request("/v1/dev/sign-in", {
                      persona:
                        data?.me.login === "demo-worker"
                          ? "requester"
                          : "worker",
                    }),
                  "Preview account switched.",
                )
              }
              disabled={busy}
            >
              Switch preview account
            </button>
          </div>
        )}
        <div className="content">
          {error && (
            <div role="alert" className="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button onClick={() => void refresh()} aria-label="Retry">
                <RefreshCw size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              <Check size={17} />
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {loading ? (
            <div className="empty">Opening your workspace…</div>
          ) : !data ? (
            <section className="welcome">
              <span className="eyebrow">YOUR IDEAS DON'T HAVE TO WAIT</span>
              <h1>
                Make room for
                <br />
                your <em>next idea.</em>
              </h1>
              <p>
                Turn available AI usage into shared progress.
                <br />
                Get help when you need it. Earn TIG when you can help.
              </p>
              <a
                className={`button primary ${!config?.githubSignIn ? "disabled" : ""}`}
                href={config?.githubSignIn ? "/auth/github" : undefined}
                aria-disabled={!config?.githubSignIn}
              >
                Continue with GitHub <ArrowRight size={18} />
              </a>
              {!config?.githubSignIn && (
                <small>
                  GitHub sign-in is being configured for this installation.
                </small>
              )}
              {config?.development && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () =>
                        request("/v1/dev/sign-in", { persona: "requester" }),
                      "Welcome to the local preview.",
                    )
                  }
                >
                  Explore local preview
                </button>
              )}
              <div className="privacy-note">
                <ShieldCheck size={16} /> Your AI credentials stay with your AI
                provider.
              </div>
              <p className="fine-print">
                We keep the task and TIG records needed to run the service.
                Optional usage analytics start off.
              </p>
            </section>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {page === "Overview"
                      ? "A GOOD DAY TO BUILD"
                      : "YOUR WORKSPACE"}
                  </span>
                  <h1>
                    {page === "Overview" ? "Your next idea starts here." : page}
                  </h1>
                  <p>
                    {page === "Overview"
                      ? "A little help when you need it. A little gold when you give it."
                      : page === "Marketplace"
                        ? "Find a project you can move forward."
                        : page === "Connections"
                          ? "Your tools. Your accounts. One connected workspace."
                          : page === "My tasks"
                            ? "Keep an eye on the work you’ve handed off."
                            : page === "Activity"
                              ? "Every TIG movement, in one place."
                              : page === "Inbox"
                                ? "See what needs your attention."
                                : page === "Insights"
                                  ? "A clearer view of the work you share."
                                  : "Make this workspace yours."}
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setModal("post")}
                >
                  <Plus size={17} /> Post a task
                </button>
              </div>
              {config?.development && page === "Overview" && (
                <section className="panel local-test-panel">
                  <div>
                    <h2>Try a task together</h2>
                    <p>
                      Post a 100 TIG file update. Your teammate can accept it
                      from Marketplace, submit a result, and receive the reward.
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const task = await request("/v1/dev/tasks", {
                          rewardTig: "100",
                        });
                        setDetail(task);
                      }, "Local test posted. 100 TIG reserved.")
                    }
                  >
                    Post local test · 100 TIG
                  </button>
                </section>
              )}
              {page === "Overview" && (
                <>
                  <section className="stats-grid" aria-label="Your balance">
                    <div className="balance-card">
                      <div className="card-label">
                        AVAILABLE TIG <Coins size={18} />
                      </div>
                      <div className="balance">
                        {number(data.wallet.available)}
                        <span>TIG</span>
                      </div>
                      <div className="balance-footer">
                        <span>Your next bit of progress.</span>
                        <button
                          onClick={() => go("Activity")}
                          aria-label="View TIG activity"
                        >
                          <ArrowUpRight size={20} />
                        </button>
                      </div>
                    </div>
                    <div className="stat-card">
                      <span className="card-label">
                        IN ESCROW <ShieldCheck size={17} />
                      </span>
                      <div className="stat-number">
                        {number(data.wallet.escrow)}
                        <small>TIG</small>
                      </div>
                      <p>Reserved for your open tasks</p>
                    </div>
                    <div className="stat-card">
                      <span className="card-label">
                        ACTIVE TASKS <Layers size={17} />
                      </span>
                      <div className="stat-number">
                        {active.length}
                        <small>in progress</small>
                      </div>
                      <p>Good things are taking shape</p>
                    </div>
                  </section>
                  <section className="handoff-banner">
                    <div className="terminal-mark">
                      <Terminal size={25} />
                    </div>
                    <div>
                      <span className="eyebrow">STAY IN YOUR FLOW</span>
                      <h2>Your AI already knows the context.</h2>
                      <p>
                        Ask it to hand off your next task. Follow the progress
                        here.
                      </p>
                      <div className="prompt">
                        “Post this task on Tokenisgold for 1,000 TIG.”
                      </div>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => go("Connections")}
                    >
                      Connect your CLI <ArrowUpRight size={16} />
                    </button>
                  </section>
                  <section>
                    <div className="section-heading">
                      <div>
                        <h2>Your AI connections</h2>
                        <p>Stay informed about your available usage.</p>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => go("Connections")}
                      >
                        Manage connections <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="connection-grid">
                      {data.connections.map((c) => (
                        <ConnectionCard
                          key={c.provider}
                          connection={c}
                          onClick={() => go("Connections")}
                        />
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="section-heading">
                      <div>
                        <h2>A little help goes a long way</h2>
                        <p>Open tasks from the community.</p>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => go("Marketplace")}
                      >
                        Browse all tasks <ArrowRight size={15} />
                      </button>
                    </div>
                    <div className="task-grid">
                      {market.slice(0, 3).map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          onClick={() => setDetail(t)}
                        />
                      ))}
                      {!market.length && (
                        <Empty
                          title="Room for the next good idea"
                          text="Community tasks will appear here when they are posted."
                        />
                      )}
                    </div>
                  </section>
                </>
              )}
              {page === "Marketplace" && (
                <>
                  <label className="search">
                    <Search size={18} />
                    <input
                      placeholder="Search open tasks"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <div className="task-grid">
                    {market.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        onClick={() => setDetail(t)}
                      />
                    ))}
                    {!market.length && (
                      <Empty
                        title="No matching tasks yet"
                        text="Try a different search, or come back when new work arrives."
                      />
                    )}
                  </div>
                </>
              )}
              {page === "My tasks" && (
                <div className="task-list">
                  {data.tasks.map((t) => (
                    <div className="task-row" key={t.id}>
                      <span className="task-icon">
                        <Code2 size={20} />
                      </span>
                      <button
                        className="row-title"
                        onClick={() => setDetail(t)}
                      >
                        <strong>{t.title}</strong>
                        <small>
                          {friendly(t.requestCategory)} · Posted{" "}
                          {date(t.createdAt)}
                        </small>
                      </button>
                      <span
                        className={`pill ${t.state === "OPEN" ? "green" : ""}`}
                      >
                        {friendly(t.state)}
                      </span>
                      <strong>
                        {number(t.rewardTig)} <small>TIG</small>
                      </strong>
                      {t.state === "OPEN" && t.requesterId === data.me.id && (
                        <button
                          className="button secondary small"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () =>
                                request(`/v1/tasks/${t.id}/cancel`, {
                                  expectedVersion: t.version,
                                }),
                              "Task cancelled. Your TIG has been restored.",
                            )
                          }
                        >
                          Cancel task
                        </button>
                      )}
                    </div>
                  ))}
                  {!data.tasks.length && (
                    <Empty
                      title="Your next task starts with a handoff"
                      text="Ask your existing AI to prepare a task, or import a saved handoff."
                    />
                  )}
                </div>
              )}
              {page === "Connections" && (
                <>
                  <div className="connection-grid">
                    {data.connections.map((c) => (
                      <ConnectionCard
                        key={c.provider}
                        connection={c}
                        onClick={() => setModal("pair")}
                      />
                    ))}
                  </div>
                  <section className="panel connect-panel">
                    <Terminal size={24} />
                    <div>
                      <h2>Connect your local workspace</h2>
                      <p>
                        Run this in the Tokenisgold project, then approve the
                        code shown on your device.
                      </p>
                      <CopyCommand
                        text={`npm run tig -- connect --origin ${location.origin}`}
                      />
                      <button
                        className="button secondary"
                        onClick={() => setModal("pair")}
                      >
                        Enter a connection code
                      </button>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>Connected devices</h2>
                    {data.devices
                      .filter((d) => !d.revoked_at)
                      .map((d) => (
                        <div className="device-row" key={d.id}>
                          <span>{d.name}</span>
                          <button
                            className="text-link"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                () => request(`/v1/devices/${d.id}/revoke`, {}),
                                "Device disconnected.",
                              )
                            }
                          >
                            Disconnect
                          </button>
                        </div>
                      ))}
                    {!data.devices.some((d) => !d.revoked_at) && (
                      <p>No devices connected yet.</p>
                    )}
                  </section>
                  <ProjectPanel data={data} onSaved={refresh} />
                </>
              )}
              {page === "Inbox" && (
                <InboxPanel
                  key={data.me.id}
                  userId={data.me.id}
                  onRead={refresh}
                  onOpen={async (id) => {
                    const task = await request(`/v1/tasks/${id}`);
                    setDetail(task);
                  }}
                />
              )}
              {page === "Insights" && (
                <InsightsPanel
                  key={data.me.id}
                  userId={data.me.id}
                  development={config?.development ?? false}
                />
              )}
              {page === "Activity" && (
                <section className="panel activity">
                  <div className="table-heading">
                    <span>Movement</span>
                    <span>Account</span>
                    <span>Amount</span>
                  </div>
                  {data.activity.map((e, i) => (
                    <div className="activity-row" key={`${e.id}:${i}`}>
                      <div>
                        <strong>
                          {e.reason === "subscription.granted"
                            ? "Weekly TIG"
                            : e.reason === "task.escrow"
                              ? "Task posted"
                              : e.reason === "development.seed"
                                ? "Preview balance"
                                : e.reason === "task.refund"
                                  ? "Task refunded"
                                  : e.reason}
                        </strong>
                        <small>{date(e.created_at)}</small>
                      </div>
                      <span>{e.kind}</span>
                      <strong
                        className={Number(e.amount) > 0 ? "positive" : ""}
                      >
                        {Number(e.amount) > 0 ? "+" : ""}
                        {number(e.amount)} TIG
                      </strong>
                    </div>
                  ))}
                  {!data.activity.length && (
                    <Empty
                      title="A fresh start"
                      text="Your weekly TIG and task activity will appear here."
                    />
                  )}
                </section>
              )}
              {page === "Settings" && (
                <>
                  <section className="panel">
                    <h2>Privacy & data</h2>
                    <div className="setting-row">
                      <div>
                        <strong>Optional product analytics</strong>
                        <p>
                          Share clicks and page views to help improve the
                          experience.
                          <br />
                          Your tasks and TIG work the same with this off.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Optional product analytics"
                        checked={data.me.optionalProductAnalytics}
                        disabled={busy}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          const previous = data.me.optionalProductAnalytics;
                          setData({
                            ...data,
                            me: {
                              ...data.me,
                              optionalProductAnalytics: enabled,
                            },
                          });
                          void action(async () => {
                            try {
                              await request(
                                "/v1/me/data-settings",
                                { optionalProductAnalytics: enabled },
                                "PATCH",
                              );
                            } catch (error) {
                              setData((current) =>
                                current
                                  ? {
                                      ...current,
                                      me: {
                                        ...current.me,
                                        optionalProductAnalytics: previous,
                                      },
                                    }
                                  : null,
                              );
                              throw error;
                            }
                          }, "Privacy preference saved.");
                        }}
                      />
                    </div>
                    <p className="fine-print">
                      Task, account and TIG records are required to operate the
                      service. Account export and deletion tools are planned
                      before public beta.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>About this preview</h2>
                    <p>
                      English-first · Public GitHub repositories · TIG has no
                      cash value.
                    </p>
                    <p>
                      Task execution and result settlement are not available in
                      this development slice.
                    </p>
                  </section>
                </>
              )}
            </>
          )}
          <footer>
            <span>tokenisgold</span>
            <span>Small contributions. Shared progress.</span>
            <span>TIG is a work credit, not cash.</span>
          </footer>
        </div>
      </main>
      {modal === "post" && data && (
        <Dialog title="Hand off your next task" onClose={() => setModal(null)}>
          <PostForm
            data={data}
            onDone={async () => {
              setModal(null);
              setNotice("Your task is live. TIG is reserved in escrow.");
              go("My tasks");
              await refresh();
            }}
          />
        </Dialog>
      )}
      {modal === "pair" && data && (
        <Dialog title="Connect this device" onClose={() => setModal(null)}>
          <PairForm
            onDone={async () => {
              setModal(null);
              history.replaceState(null, "", location.pathname);
              setNotice("Device approved. Return to your terminal.");
              await refresh();
            }}
          />
        </Dialog>
      )}
      {detail && (
        <Dialog title={detail.title} onClose={() => setDetail(null)}>
          {data && (
            <TaskTransaction
              key={`${detail.id}:${data.me.id}`}
              id={detail.id}
              userId={data.me.id}
              onChange={refresh}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <Layers size={28} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function ConnectionCard({
  connection: c,
  onClick,
}: {
  connection: Dashboard["connections"][number];
  onClick: () => void;
}) {
  return (
    <button className="connection-card" onClick={onClick}>
      <div className={`provider-icon ${c.provider}`}>
        {c.provider === "codex" ? <Code2 size={23} /> : <span>✳</span>}
      </div>
      <div className="connection-body">
        <strong>{c.provider === "codex" ? "Codex" : "Claude Code"}</strong>
        <p>{c.planId ?? "Connect your existing account"}</p>
        <small>
          {c.verification === "verified"
            ? "Subscription verified"
            : "Weekly TIG awaits subscription verification"}
        </small>
      </div>
      <span className={`pill ${c.signal === "spare" ? "green" : ""}`}>
        {c.signal === "low"
          ? "Usage running low"
          : c.signal === "spare"
            ? "Usage available"
            : "Usage unknown"}
      </span>
    </button>
  );
}
function TaskCard({
  task: t,
  onClick,
}: {
  task: TaskView;
  onClick: () => void;
}) {
  return (
    <button className="task-card" onClick={onClick}>
      <div className="task-card-top">
        <span className="task-icon">
          <Code2 size={19} />
        </span>
        <span className="pill">{friendly(t.requestCategory)}</span>
      </div>
      <h3>{t.title}</h3>
      <p>
        {t.aiRequirement.provider === "codex" ? "Codex" : "Claude Code"}{" "}
        <span>·</span> {t.aiRequirement.model}
      </p>
      <div className="task-card-bottom">
        <span>
          <Clock size={13} />
          {date(t.executionDeadlineAt)}
        </span>
        <strong>
          {number(t.rewardTig)} <small>TIG</small>
          <ArrowUpRight size={16} />
        </strong>
      </div>
    </button>
  );
}
function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div>
      <div className="copy-command">
        <code>{text}</code>
        <button
          aria-label="Copy command"
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => setCopied(true))
              .catch(() => setError("Select and copy the command above."))
          }
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {error && <small>{error}</small>}
    </div>
  );
}
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function PairForm({ onDone }: { onDone: () => Promise<void> }) {
  const [code, setCode] = useState(
      new URLSearchParams(location.search).get("connect") ?? "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void request("/v1/device-authorizations/approve", {
          userCode: code.toUpperCase().replaceAll(" ", ""),
        })
          .then(onDone)
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <p>
        Only approve a code displayed by the CLI you just started. A connected
        device can post tasks using your TIG.
      </p>
      <label>
        Connection code
        <input
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          maxLength={12}
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        Approve device <ArrowRight size={16} />
      </button>
    </form>
  );
}
function ProjectPanel({
  data,
  onSaved,
}: {
  data: Dashboard;
  onSaved: () => Promise<void>;
}) {
  const [repo, setRepo] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <h2>Your projects</h2>
      {data.projects.map((p) => (
        <div className="device-row" key={p.id}>
          <span>
            <GitBranch size={15} /> {p.repository}
          </span>
          <span className="pill">Public</span>
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void request("/v1/projects", {
            repository: repo,
            projectType: "software",
            stack: [],
          })
            .then(() => {
              setRepo("");
              return onSaved();
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Public GitHub repository
          <input
            required
            placeholder="owner/repository"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy}>
          Connect project
        </button>
      </form>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
function PostForm({
  data,
  onDone,
}: {
  data: Dashboard;
  onDone: () => Promise<void>;
}) {
  const [artifact, setArtifact] = useState<ReturnType<
      typeof artifactSchema.parse
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [projectId, setProject] = useState(data.projects[0]?.id ?? ""),
    [title, setTitle] = useState(""),
    [scope, setScope] = useState(""),
    [checks, setChecks] = useState(""),
    [provider, setProvider] = useState("codex"),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState(""),
    [reward, setReward] = useState("1000"),
    [category, setCategory] = useState("feature"),
    [deadline, setDeadline] = useState(() => {
      const d = new Date(Date.now() + 86400000);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    });
  const submission = useRef<{ fingerprint: string; body: unknown } | null>(
    null,
  );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!artifact) {
      setError("Import a local handoff first.");
      return;
    }
    setBusy(true);
    try {
      const fingerprint = JSON.stringify({
        artifact,
        projectId,
        title,
        scope,
        checks,
        provider,
        model,
        effort,
        reward,
        category,
        deadline,
      });
      if (submission.current?.fingerprint !== fingerprint) {
        const saved = await request("/v1/artifacts", artifact);
        submission.current = {
          fingerprint,
          body: {
            projectId,
            title,
            scope,
            requestCategory: category,
            acceptanceChecks: checks
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            aiRequirement: { provider, model, effort, source: "declared" },
            rewardTig: reward,
            baseCommit: artifact.baseCommit,
            handoffArtifactId: saved.id,
            packageManifestHash: artifact.manifestHash,
            executionDeadlineAt: new Date(deadline).toISOString(),
            commandApproval: {
              kind: "explicit_post",
              text: `Post ${title} for ${reward} TIG`,
            },
          },
        };
      }
      await request("/v1/tasks", submission.current.body);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <p>
        Keep the context your AI prepared. Review the scope and post with one
        action.
      </p>
      <label className="upload">
        <FileText size={20} />
        <span>
          {artifact
            ? `${artifact.files.length} files · Handoff ready`
            : "Import a saved handoff"}
          <small>
            Export from your CLI with: tig export --output handoff.json
          </small>
        </span>
        <input
          aria-label="Import handoff"
          type="file"
          accept=".json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void f
                .text()
                .then((t) => {
                  const a = artifactSchema.parse(JSON.parse(t));
                  setArtifact(a);
                  setScope(a.summary);
                  setError("");
                })
                .catch(() =>
                  setError("Choose a valid Tokenisgold handoff file."),
                );
          }}
        />
      </label>
      <label>
        Project
        <select
          required
          value={projectId}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">Choose a connected project</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.repository}
            </option>
          ))}
        </select>
      </label>
      <label>
        What needs to be done?
        <input
          required
          minLength={3}
          maxLength={140}
          placeholder="Add a keyboard shortcut to search"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Scope
        <textarea
          required
          minLength={10}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          rows={3}
        />
      </label>
      <label>
        How will we know it is done?
        <textarea
          required
          placeholder="One acceptance check per line"
          value={checks}
          onChange={(e) => setChecks(e.target.value)}
          rows={2}
        />
      </label>
      <div className="form-grid">
        <label>
          Task type
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              "build",
              "feature",
              "bug",
              "refactor",
              "test",
              "review",
              "docs",
              "setup",
              "other",
            ].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Reward · TIG
          <input
            required
            inputMode="decimal"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
          />
        </label>
        <label>
          AI tool
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          Model
          <input
            required
            placeholder="Exact requested model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label>
          Reasoning level
          <input
            required
            placeholder="Requested reasoning level"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          />
        </label>
        <label>
          Completion deadline
          <input
            type="datetime-local"
            required
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </label>
      </div>
      <p className="fine-print">
        Posting shares this handoff and reserves {number(reward || "0")} TIG.
        Cancel before acceptance to restore it. Model support is not verified in
        this preview.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="button primary wide" disabled={busy || !projectId}>
        {busy ? "Posting…" : `Post task · ${number(reward || "0")} TIG`}
        <ArrowRight size={17} />
      </button>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
