import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { truncate } from "@t3tools/shared/String";
import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { useNavigate } from "@tanstack/react-router";
import { useState, type Dispatch, type SetStateAction } from "react";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../proposedPlan";
import type { LatestProposedPlanState } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { type ChatMessage } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  formatOutgoingPrompt,
  type makeThreadErrorSetter,
  waitForStartedServerThread,
} from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { useTimelineFollow } from "./useTimelineFollow";

type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;

interface UseProposedPlanActionsInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadBranch: string | null;
  readonly activeProject: EnvironmentProject | null;
  readonly isServerThread: boolean;
  readonly isSendBusy: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  /** The local checkout's branch when it differs from the thread's, so the turn records it. */
  readonly localCheckoutBranch: string | null;
  readonly composerRef: ComposerHandleRef;
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly anchorNewTurn: ReturnType<typeof useTimelineFollow>["anchorNewTurn"];
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: EnvironmentThreadShell["id"];
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Executes a proposed plan: on this thread with the chosen permissions (linking the turn to
 * the plan), or in a fresh thread that starts from the plan and then opens. Both paths share
 * the route's send lock and keep the composer's mode on Build once they start.
 */
export function useProposedPlanActions(input: UseProposedPlanActionsInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProject,
    isServerThread,
    isSendBusy,
    activeEnvironmentUnavailable,
    localCheckoutBranch,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
    persistThreadSettingsForNextTurn,
  } = input;
  const navigate = useNavigate();
  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const [isApproving, setIsApproving] = useState(false);

  const readSendContext = () => {
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return null;
    return sendCtx;
  };

  const canStartPlanExecution = () =>
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) &&
    activeThread !== undefined &&
    isServerThread &&
    !isSendBusy &&
    !activeEnvironmentUnavailable &&
    !sendInFlightRef.current;

  const approvePlan = async (
    targetRuntimeMode: RuntimeMode,
    plan: LatestProposedPlanState,
  ): Promise<boolean> => {
    if (!canStartPlanExecution() || activeThread === undefined) return false;
    const sendCtx = readSendContext();
    if (sendCtx === null) return false;

    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: buildPlanImplementationPrompt(plan.planMarkdown),
    });

    sendInFlightRef.current = true;
    setIsApproving(true);
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);

    anchorNewTurn(
      scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageIdForSend,
    );
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingImplementationPrompt,
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    try {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(localCheckoutBranch ? { branch: localCheckoutBranch } : {}),
        runtimeMode: targetRuntimeMode,
        interactionMode: "default",
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        const threadRef = scopeThreadRef(activeThread.environmentId, threadIdForSend);
        setComposerDraftRuntimeMode(threadRef, targetRuntimeMode);
        setComposerDraftInteractionMode(threadRef, "default");
        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingImplementationPrompt,
              attachments: [],
            },
            modelSelection: sendCtx.selectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode: targetRuntimeMode,
            interactionMode: "default",
            sourceProposedPlan: {
              threadId: activeThread.id,
              planId: plan.id,
            },
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) return true;

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : m(msg("Failed to start plan execution.")),
        );
      }
      return false;
    } finally {
      sendInFlightRef.current = false;
      setIsApproving(false);
      resetLocalDispatch();
    }
  };

  const implementPlanInNewThread = async (
    targetRuntimeMode: RuntimeMode,
    plan: LatestProposedPlanState,
  ): Promise<void> => {
    if (!canStartPlanExecution() || activeThread === undefined || activeProject === null) return;
    const sendCtx = readSendContext();
    if (sendCtx === null) return;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: buildPlanImplementationPrompt(plan.planMarkdown),
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(plan.planMarkdown));
    const nextThreadModelSelection: ModelSelection = sendCtx.selectedModelSelection;

    sendInFlightRef.current = true;
    setIsApproving(true);
    beginLocalDispatch({ preparingWorktree: false });

    try {
      const createResult = await createThread({
        environmentId,
        input: {
          threadId: nextThreadId,
          projectId: activeProject.id,
          title: nextThreadTitle,
          modelSelection: nextThreadModelSelection,
          runtimeMode: targetRuntimeMode,
          interactionMode: "default",
          branch: activeThreadBranch,
          worktreePath: activeThread.worktreePath,
          createdAt,
        },
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        createResult._tag === "Failure" ? createResult : null;

      if (failure === null) {
        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: nextThreadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: outgoingImplementationPrompt,
              attachments: [],
            },
            modelSelection: nextThreadModelSelection,
            titleSeed: nextThreadTitle,
            runtimeMode: targetRuntimeMode,
            interactionMode: "default",
            sourceProposedPlan: {
              threadId: activeThread.id,
              planId: plan.id,
            },
            createdAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        const startedResult = await settlePromise(() =>
          waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
        );
        failure = startedResult._tag === "Failure" ? startedResult : null;
      }

      if (failure === null) {
        const navigateResult = await settlePromise(() =>
          navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: activeThread.environmentId,
              threadId: nextThreadId,
            },
          }),
        );
        failure = navigateResult._tag === "Failure" ? navigateResult : null;
      }

      if (failure === null) {
        // The implementation now runs in the new thread on Build; the source thread leaves
        // Plan mode so it does not keep planning a plan that is already being built.
        if (activeThread.interactionMode === "plan") {
          setComposerDraftInteractionMode(
            scopeThreadRef(activeThread.environmentId, activeThread.id),
            "default",
          );
          // Best effort: a failure here must not roll back the navigation above.
          await persistThreadSettingsForNextTurn({
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...(localCheckoutBranch ? { branch: localCheckoutBranch } : {}),
            runtimeMode: activeThread.runtimeMode,
            interactionMode: "default",
          });
        }
        return;
      }

      const cleanupResult = await deleteThread({
        environmentId,
        input: { threadId: nextThreadId },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not start implementation thread")),
            description:
              error instanceof Error
                ? error.message
                : m(msg("An error occurred while creating the new thread.")),
          }),
        );
      }
    } finally {
      sendInFlightRef.current = false;
      setIsApproving(false);
      resetLocalDispatch();
    }
  };

  return { approvePlan, implementPlanInNewThread, isApproving };
}
