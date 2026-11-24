import {
  EnvironmentId,
  NodeId,
  PlanId,
  ProjectId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  wrappedProjection: null as { readonly projection: unknown } | null,
  projectionListeners: new Set<() => void>(),
}));

function setProjection(projection: unknown) {
  state.wrappedProjection = projection === null ? null : { projection };
  for (const listener of state.projectionListeners) listener();
}

vi.mock(import("~/state/entities"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal()),
    useProject: ((ref: unknown) =>
      ref === null
        ? null
        : {
            id: "project",
            environmentId: "environment",
            title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
            workspaceRoot: state.workspaceRoot,
            scripts: [],
          }) as never,
    useProjects: (() => []) as never,
    useQuietThreadShell: ((ref: unknown) =>
      ref === null
        ? null
        : {
            id: "thread",
            environmentId: "environment",
            projectId: "project",
            worktreePath: state.folder,
            branch: null,
            pullRequests: state.pullRequests,
          }) as never,
    useQuietThreadProjection: ((ref: unknown) => {
      const wrapped = useSyncExternalStore(
        (listener) => {
          state.projectionListeners.add(listener);
          return () => state.projectionListeners.delete(listener);
        },
        () => state.wrappedProjection,
      );
      return ref === null ? null : wrapped;
    }) as never,
    useServerConfigs: (() =>
      new Map(
        state.configLoaded
          ? [
              [
                EnvironmentId.make("environment"),
                {
                  scratchWorkspaceRoot: SCRATCH_ROOT,
                  environment: { capabilities: { pullRequests: true } },
                },
              ],
            ]
          : [],
      )) as never,
  };
});
// Neither folder is a repository, which is what the server reports for both.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});

import { act, render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  projection?: unknown;
  todosVisible?: boolean;
}) {
  __resetClientSettingsPersistenceForTests();
  if (input.todosVisible === false) {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { todos: false },
    });
  } else {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  }
  state.configLoaded = input.configLoaded ?? true;
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  setProjection(input.projection ?? null);
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => {
      anchor.remove();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

function Panel({ fixture }: { fixture: ReturnType<typeof setup> }) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={threadRef}
        worktreePath={state.folder}
        isServerThread
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={false}
        envLocked
        availableEnvironments={[]}
        onEnvModeChange={noop}
        envMode="local"
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{} as never}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

function makeProjection(input: { runs: unknown[]; plans: unknown[]; turnItems: unknown[] }) {
  return {
    thread: {
      id: threadRef.threadId,
      projectId: ProjectId.make("project"),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadRef.threadId,
      },
      forkedFrom: null,
    },
    runs: input.runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: input.plans,
    turnItems: input.turnItems,
    visibleTurnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
  };
}

it("renders the thread todo list in the details panel and reacts to updates and collapsing", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    projection: makeProjection({
      runs: [{ id: RunId.make("run-1"), ordinal: 1, status: "running" }],
      plans: [
        {
          id: PlanId.make("plan-1"),
          threadId: threadRef.threadId,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-1"),
          kind: "todo_list",
          status: "active",
          explanation: "Working on TodoRead",
          steps: [
            { id: "1", text: "Add TodoRead tool", status: "completed" },
            { id: "2", text: "Render todo section", status: "running" },
          ],
        },
      ],
      turnItems: [],
    }),
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Tasks" })).toBeVisible();
  await expect.element(page.getByText("1/2")).toBeVisible();
  await expect.element(page.getByText("Working on TodoRead")).toBeVisible();
  await expect.element(page.getByText("Add TodoRead tool")).toBeVisible();
  await expect.element(page.getByText("Render todo section")).toBeVisible();

  await page.getByRole("button", { name: "Collapse todo list" }).click();
  await expect.element(page.getByText("Add TodoRead tool")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Expand todo list" }).click();
  await expect.element(page.getByText("Add TodoRead tool")).toBeVisible();

  await act(() => {
    setProjection(
      makeProjection({
        runs: [{ id: RunId.make("run-1"), ordinal: 1, status: "completed" }],
        plans: [
          {
            id: PlanId.make("plan-2"),
            threadId: threadRef.threadId,
            runId: RunId.make("run-1"),
            nodeId: NodeId.make("node-2"),
            kind: "todo_list",
            status: "completed",
            steps: [],
          },
        ],
        turnItems: [],
      }),
    );
  });
  await expect.element(page.getByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
});

it("hides the thread todo list when disabled in thread details settings", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    todosVisible: false,
    projection: makeProjection({
      runs: [{ id: RunId.make("run-1"), ordinal: 1, status: "running" }],
      plans: [
        {
          id: PlanId.make("plan-1"),
          threadId: threadRef.threadId,
          runId: RunId.make("run-1"),
          nodeId: NodeId.make("node-1"),
          kind: "todo_list",
          status: "active",
          steps: [{ id: "1", text: "Hidden step", status: "running" }],
        },
      ],
      turnItems: [],
    }),
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
});
