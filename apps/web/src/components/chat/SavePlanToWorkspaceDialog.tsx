import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { type ReactNode, useId, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** What both the timeline card and the plan panel offer for one plan's markdown. */
export interface PlanExportActions {
  readonly copyToClipboard: () => void;
  readonly isCopied: boolean;
  readonly downloadPlan: () => void;
  readonly canSaveToWorkspace: boolean;
  readonly openSaveDialog: () => void;
  /** The save dialog itself, owned here so a caller only places it in its tree. */
  readonly dialog: ReactNode;
}

export interface PlanExportTarget {
  readonly planMarkdown: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
}

/**
 * Copying, downloading, and saving a plan to the workspace, shared by every place a plan is
 * shown so the file name and export format cannot drift apart.
 */
export function usePlanExportActions(target: PlanExportTarget): PlanExportActions {
  const gt = useGT();
  const { planMarkdown, environmentId, workspaceRoot } = target;
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [lastSavePath, setLastSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "plan",
      unavailableMessage: msg("Clipboard API is unavailable while copying plan."),
      failureMessage: msg("Failed to copy plan to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy plan"),
          description:
            error instanceof Error ? error.message : gt("An error occurred while copying."),
        }),
      );
    },
  });
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const downloadPlan = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const copyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!canWriteFiles) return;
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Workspace path is unavailable"),
          description: gt("This thread does not have a workspace path to save into."),
        }),
      );
      return;
    }
    setIsSaveDialogOpen(true);
  };

  const saveToWorkspace = (savePath: string) => {
    const relativePath = savePath.trim();
    if (!workspaceRoot || !readEnvironmentScope(environmentId, AuthFilesystemWriteScope)) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: gt("Enter a workspace path"),
      });
      return;
    }

    setLastSavePath(savePath);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: gt("Plan saved to workspace"),
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not save plan"),
            description:
              error instanceof Error ? error.message : gt("An error occurred while saving."),
          }),
        );
      }
    })();
  };

  return {
    copyToClipboard: copyPlan,
    isCopied,
    downloadPlan,
    canSaveToWorkspace: canWriteFiles && workspaceRoot !== undefined,
    openSaveDialog,
    dialog: (
      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <SavePlanToWorkspaceForm
            initialPath={lastSavePath || downloadFilename}
            placeholder={downloadFilename}
            workspaceRoot={workspaceRoot}
            canWriteFiles={canWriteFiles}
            saving={isSavingToWorkspace}
            onCancel={() => setIsSaveDialogOpen(false)}
            onSave={saveToWorkspace}
          />
        </DialogPopup>
      </Dialog>
    ),
  };
}

function SavePlanToWorkspaceForm({
  initialPath,
  placeholder,
  workspaceRoot,
  canWriteFiles,
  saving,
  onCancel,
  onSave,
}: {
  initialPath: string;
  placeholder: string;
  workspaceRoot: string | undefined;
  canWriteFiles: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (path: string) => void;
}) {
  const gt = useGT();
  const [savePath, setSavePath] = useState(initialPath);
  const savePathInputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Save plan to workspace</T>
        </DialogTitle>
        <DialogDescription>
          {workspaceRoot !== undefined ? (
            <T>
              Enter a path relative to{" "}
              <code>
                <Var>{workspaceRoot}</Var>
              </code>
              .
            </T>
          ) : (
            <T>
              Enter a path relative to <code>the workspace</code>.
            </T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label htmlFor={savePathInputId} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">
            <T>Workspace path</T>
          </span>
          <Input
            id={savePathInputId}
            value={savePath}
            onChange={(event) => setSavePath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={saving}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          <T>Cancel</T>
        </Button>
        <Button size="sm" onClick={() => onSave(savePath)} disabled={!canWriteFiles || saving}>
          {saving ? gt("Saving...") : gt("Save")}
        </Button>
      </DialogFooter>
    </>
  );
}
