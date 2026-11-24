import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type PiNativeCatalogStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { PI_NATIVE_API_STYLES } from "@t3tools/client-runtime/pi-native-catalog";
import { squashAtomCommandFailure, settlePromise } from "@t3tools/client-runtime/state/runtime";

import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { m as resolveNow } from "../../../i18n/messages";
import { cn } from "../../../lib/utils";
import { normalizeProviderAccentColor } from "../../../providerInstances";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
} from "../../../hooks/useSettings";
import { ManagedNotice } from "../../ManagedPolicy";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useManagedPolicy } from "../../../state/managedPolicy";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../ui/empty";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { PiNativeServiceDialog, type PiNativeServiceDialogMode } from "./PiNativeServiceDialog";
import {
  PI_NATIVE_DRIVER_KIND,
  applySortOrderToProviderInstances,
  buildReorderSortUpdates,
  listPiNativeServices,
  moveListEntry,
  presetForService,
  serviceDisplayLabel,
  type PiNativeService,
} from "./piNativeModels.logic";

interface RowTestResult {
  readonly kind: "ok" | "warning" | "error";
  readonly message: string;
}

function hostSummary(baseUrl: string): string {
  if (baseUrl.trim() === "") return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function enabledInstance(
  instance: ProviderInstanceConfig,
  enabled: boolean,
): ProviderInstanceConfig {
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? { ...(instance.config as Record<string, unknown>), enabled }
      : { enabled };
  return { ...instance, enabled, config };
}

function ServiceSwatch(props: { readonly service: PiNativeService }) {
  const preset = presetForService(props.service);
  const color =
    normalizeProviderAccentColor(props.service.instance.accentColor) ??
    normalizeProviderAccentColor(preset?.accentColor);
  const label = serviceDisplayLabel(props.service);
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60 text-xs font-semibold"
      style={color === undefined ? undefined : { backgroundColor: `${color}1f`, color }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function LiveStatusBadge(props: { readonly provider: ServerProvider | undefined }) {
  const gt = useGT();
  const provider = props.provider;
  if (provider === undefined) return null;
  const variant =
    provider.status === "ready"
      ? ("success" as const)
      : provider.status === "error"
        ? ("error" as const)
        : ("warning" as const);
  const label =
    provider.status === "ready"
      ? gt("Ready")
      : provider.status === "error"
        ? gt("Error")
        : gt("Warning");
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

function ServiceRow(props: {
  readonly service: PiNativeService;
  readonly provider: ServerProvider | undefined;
  readonly position: number;
  readonly count: number;
  readonly busy: boolean;
  readonly testing: boolean;
  readonly disabled: boolean;
  readonly testResult: RowTestResult | undefined;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onTest: () => void;
  readonly onEdit: () => void;
  readonly onCopy: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  const gt = useGT();
  const { service, disabled } = props;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(service.instanceId) });
  const name = serviceDisplayLabel(service);
  // The row's own stored style is the truth; a preset lookup may resolve a sibling preset.
  const apiStyleLabel =
    PI_NATIVE_API_STYLES.find((style) => style.value === service.apiStyle)?.label ??
    service.apiStyle;
  const defaultModel = service.modelBindings[0]?.id ?? service.defaultModel;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-start gap-2 px-3 py-2.5 sm:px-4",
        isDragging && "relative z-10 rounded-lg bg-card shadow-md",
      )}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        className="mt-1 hidden size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing @min-[42rem]/models:flex"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <ServiceSwatch service={service} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <Badge size="sm" variant="secondary">
            {apiStyleLabel}
          </Badge>
          <LiveStatusBadge provider={props.provider} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
          <span className="truncate">{hostSummary(service.baseUrl) || gt("Default endpoint")}</span>
          <span aria-hidden>·</span>
          <span>
            {gt("{count} models", { count: service.modelBindings.length })}
            {defaultModel.trim() === ""
              ? ""
              : ` · ${gt("Default {model}", { model: defaultModel })}`}
          </span>
        </div>
        {props.testResult === undefined ? null : (
          <p
            role="status"
            className={cn(
              "text-2xs",
              props.testResult.kind === "ok" && "text-success-foreground",
              props.testResult.kind === "warning" && "text-warning-foreground",
              props.testResult.kind === "error" && "text-destructive",
            )}
          >
            {props.testResult.message}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
        <Switch
          size="sm"
          checked={service.enabled}
          disabled={disabled || props.busy}
          aria-label={gt("Enable {name}", { name })}
          onCheckedChange={props.onToggleEnabled}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || props.busy || props.testing}
          aria-label={gt("Test {name}", { name })}
          onClick={props.onTest}
        >
          {props.testing ? <Spinner /> : <ZapIcon />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || props.busy}
          aria-label={gt("Edit {name}", { name })}
          onClick={props.onEdit}
        >
          <PencilIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || props.busy}
          aria-label={gt("Copy {name}", { name })}
          onClick={props.onCopy}
        >
          <CopyIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || props.busy || props.position === 1}
          aria-label={gt("Move {name} up", { name })}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={disabled || props.busy || props.position === props.count}
          aria-label={gt("Move {name} down", { name })}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-destructive"
          disabled={disabled || props.busy}
          aria-label={gt("Delete {name}", { name })}
          onClick={props.onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}

function CatalogStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const catalogStatus = useAtomCommand(serverEnvironment.piNativeCatalogStatus, {
    reportFailure: false,
  });
  const refreshCatalog = useAtomCommand(serverEnvironment.piNativeRefreshCatalog, {
    reportFailure: false,
  });
  const [status, setStatus] = useState<PiNativeCatalogStatus>();
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadStatus = useStableCallback(async (): Promise<PiNativeCatalogStatus | undefined> => {
    const result = await catalogStatus({ environmentId: props.environmentId, input: {} });
    return result._tag === "Success" ? result.value : undefined;
  });

  // The catalog lives on the server, so its status is read once per mount.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server catalog status over the RPC connection on mount
  useEffect(() => {
    let current = true;
    void loadStatus().then((next) => {
      if (!current) return;
      if (next === undefined) setFailed(true);
      else setStatus(next);
    });
    return () => {
      current = false;
    };
  }, [loadStatus]);

  const refresh = async () => {
    setRefreshing(true);
    const result = await refreshCatalog({ environmentId: props.environmentId, input: {} });
    setRefreshing(false);
    if (result._tag === "Success") {
      setStatus(result.value.status);
      if (result.value.updated) {
        toastManager.add({ type: "success", title: gt("Model catalog refreshed") });
      }
      return;
    }
    toastManager.add({
      type: "error",
      title: gt("Could not refresh the model catalog"),
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
        gt("The catalog request failed."),
    });
  };

  const sourceLabel =
    status === undefined
      ? gt("Catalog status unavailable")
      : status.source === "remote"
        ? gt("Remote models.dev catalog")
        : status.source === "bundled"
          ? gt("Bundled models.dev catalog")
          : gt("Catalog not loaded");

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-2xs text-muted-foreground sm:px-4">
      <span className="min-w-0">
        {failed ? gt("Catalog status unavailable") : sourceLabel}
        {status === undefined
          ? null
          : ` · ${gt("{vendors} vendors · {models} models", {
              vendors: status.providerCount,
              models: status.modelCount,
            })}`}
        {status?.fetchedAt === undefined
          ? null
          : ` · ${gt("updated {time}", { time: new Date(status.fetchedAt).toLocaleString() })}`}
      </span>
      {status?.lastError === undefined ? null : (
        <Badge size="sm" variant="error">
          {status.lastError}
        </Badge>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        className="ms-auto"
        disabled={props.disabled || refreshing}
        onClick={() => void refresh()}
      >
        <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
        {refreshing ? gt("Refreshing") : gt("Refresh catalog")}
      </Button>
    </div>
  );
}

export function PiNativeModelsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(props.environmentId);
  const managedPolicy = useManagedPolicy(props.environmentId);
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const canRefresh = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    props.environmentId,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const testConnection = useAtomCommand(serverEnvironment.piNativeTestConnection, {
    reportFailure: false,
  });
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));

  const [dialog, setDialog] = useState<PiNativeServiceDialogMode | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [testResults, setTestResults] = useState<Readonly<Record<string, RowTestResult>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const busyRef = useRef<Set<string>>(new Set());

  const services = listPiNativeServices(settings.providerInstances);
  const existingInstanceIds = Object.keys(settings.providerInstances ?? {});
  const policyAllows = isManagedDriverAllowed(managedPolicy, PI_NATIVE_DRIVER_KIND);
  const disabled = props.readOnly === true || !canManage || !policyAllows;

  const refreshLive = async () => {
    if (!canRefresh || refreshing) return;
    setRefreshing(true);
    const result = await refreshProviders({
      environmentId: props.environmentId,
      input: { refreshModels: true, reloadSecrets: false },
    });
    setRefreshing(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: gt("Could not refresh provider status"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
          gt("The refresh request failed."),
      });
    }
  };

  const setRowBusy = useStableCallback((instanceId: string, busy: boolean) => {
    if (busy) busyRef.current.add(instanceId);
    else busyRef.current.delete(instanceId);
    setBusyIds(new Set(busyRef.current));
  });

  const applyInstances = async (orderedIds: ReadonlyArray<ProviderInstanceId>) => {
    if (!canManage) return;
    updateSettings({
      providerInstances: applySortOrderToProviderInstances(
        settings.providerInstances,
        buildReorderSortUpdates(orderedIds),
      ),
    });
  };

  const moveService = (instanceId: ProviderInstanceId, direction: -1 | 1) => {
    const ids = services.map((service) => service.instanceId);
    const from = ids.indexOf(instanceId);
    if (from === -1) return;
    void applyInstances(moveListEntry(ids, from, from + direction));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const ids = services.map((service) => service.instanceId);
    const from = ids.findIndex((id) => String(id) === String(event.active.id));
    const to = ids.findIndex((id) => String(id) === String(event.over?.id));
    if (from === -1 || to === -1) return;
    void applyInstances(moveListEntry(ids, from, to));
  };

  const toggleEnabled = async (service: PiNativeService, enabled: boolean) => {
    setRowBusy(String(service.instanceId), true);
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: service.instanceId,
      instance: enabledInstance(service.instance, enabled),
    });
    setRowBusy(String(service.instanceId), false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: gt("Could not update this service"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
          gt("The settings update failed."),
      });
    }
  };

  const runTest = async (service: PiNativeService) => {
    setTestingIds((current) => new Set(current).add(String(service.instanceId)));
    const result = await testConnection({
      environmentId: props.environmentId,
      input: {
        apiStyle: service.apiStyle,
        baseUrl: service.baseUrl,
        instanceId: service.instanceId,
        ...(service.vendorKey.trim() === "" ? {} : { vendorKey: service.vendorKey }),
        ...(Object.keys(service.headers).length === 0 ? {} : { headers: service.headers }),
      },
    });
    setTestingIds((current) => {
      const next = new Set(current);
      next.delete(String(service.instanceId));
      return next;
    });
    const message =
      result._tag !== "Success"
        ? {
            kind: "error" as const,
            message:
              thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
              gt("The connection test failed."),
          }
        : !result.value.ok
          ? {
              kind: "error" as const,
              message: result.value.error ?? gt("The endpoint did not answer."),
            }
          : result.value.warning === undefined
            ? {
                kind: "ok" as const,
                message: gt("Connected in {latency} ms{models}.", {
                  latency: String(result.value.latencyMs),
                  models:
                    result.value.modelCount === undefined
                      ? ""
                      : gt(", {count} models", { count: result.value.modelCount }),
                }),
              }
            : { kind: "warning" as const, message: result.value.warning };
    setTestResults((current) => ({ ...current, [String(service.instanceId)]: message }));
  };

  const deleteService = async (service: PiNativeService) => {
    const name = serviceDisplayLabel(service);
    const confirmed = await settlePromise(() =>
      ensureLocalApi().dialogs.confirm(gt("Delete {name}?", { name }), { variant: "destructive" }),
    );
    if (confirmed._tag !== "Success" || !confirmed.value) return;
    setRowBusy(String(service.instanceId), true);
    const result = await persistProviderInstance({
      operation: "remove",
      instanceId: service.instanceId,
    });
    setRowBusy(String(service.instanceId), false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: gt("Could not delete this service"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
          gt("The settings update failed."),
      });
      return;
    }
    toastManager.add({ type: "success", title: gt("{name} deleted", { name }) });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = services.map((service) => String(service.instanceId));

  const dialogNode =
    dialog === null ? null : (
      <PiNativeServiceDialog
        key={
          dialog.kind === "create"
            ? "create"
            : String((dialog.kind === "edit" ? dialog.service : dialog.source).instanceId)
        }
        environmentId={props.environmentId}
        mode={dialog}
        existingInstanceIds={existingInstanceIds}
        sortOrder={services.length}
        readOnly={disabled}
        onClose={() => setDialog(null)}
        onSaved={() => setDialog(null)}
      />
    );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title={gt("Pi Native Models")}
        variant="plain"
        titleAction={
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="compact"
              variant="ghost-muted"
              disabled={refreshing || !canRefresh}
              onClick={() => void refreshLive()}
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              {refreshing ? gt("Refreshing") : gt("Refresh")}
            </Button>
            <Button
              type="button"
              size="compact"
              disabled={disabled}
              onClick={() => setDialog({ kind: "create" })}
            >
              <PlusIcon className="size-3.5" />
              {gt("Add service")}
            </Button>
          </div>
        }
      >
        {!policyAllows ? (
          <ManagedNotice>
            {gt("An administrator policy does not allow Pi Native services on this device.")}
          </ManagedNotice>
        ) : props.readOnly === true || !canManage ? (
          <ManagedNotice>
            {gt("This session can view these services but cannot change them.")}
          </ManagedNotice>
        ) : null}

        <SettingsGroup divided={false} className="@container/models overflow-hidden">
          {services.length === 0 ? (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerIcon />
                </EmptyMedia>
                <EmptyTitle>{gt("No Pi Native services yet")}</EmptyTitle>
                <EmptyDescription>
                  {gt(
                    "Add an OpenAI, Anthropic, Gemini or custom endpoint once, then choose the models every thread can run on.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  size="compact"
                  disabled={disabled}
                  onClick={() => setDialog({ kind: "create" })}
                >
                  <PlusIcon className="size-3.5" />
                  {gt("Add your first service")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                <ul className="divide-y divide-border/50">
                  {services.map((service, index) => (
                    <ServiceRow
                      key={service.instanceId}
                      service={service}
                      position={index + 1}
                      count={services.length}
                      provider={providers.find(
                        (provider) => provider.instanceId === service.instanceId,
                      )}
                      busy={busyIds.has(String(service.instanceId))}
                      testing={testingIds.has(String(service.instanceId))}
                      disabled={disabled}
                      testResult={testResults[String(service.instanceId)]}
                      onToggleEnabled={(enabled) => void toggleEnabled(service, enabled)}
                      onTest={() => void runTest(service)}
                      onEdit={() => setDialog({ kind: "edit", service })}
                      onCopy={() => setDialog({ kind: "copy", source: service })}
                      onMove={(direction) => moveService(service.instanceId, direction)}
                      onDelete={() => void deleteService(service)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
          <div className="border-t border-border/50 py-2">
            <CatalogStrip environmentId={props.environmentId} disabled={disabled} />
          </div>
        </SettingsGroup>

        {services.length === 0 ? (
          <p className="px-3 text-2xs text-muted-foreground sm:px-4">
            {gt("Threads pick these models in the composer, one list per service.")}
          </p>
        ) : null}
      </SettingsSection>
      {dialogNode}
    </SettingsPageContainer>
  );
}
