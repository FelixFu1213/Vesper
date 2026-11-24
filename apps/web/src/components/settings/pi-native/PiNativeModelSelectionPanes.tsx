import type { EnvironmentId, ProviderInstanceId, SettingsSecretValue } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  bindingForCustomModel,
  bindingFromModelInfo,
  formatTokenCount,
  recommendModelsForService,
  type ModelFilter,
  type PiNativeApiStyle,
  type PiNativeModelBinding,
  type PiNativeModelInfo,
} from "@t3tools/client-runtime/pi-native-catalog";
import { msg, useGT, useMessages } from "gt-react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { m as resolveNow } from "../../../i18n/messages";
import { cn } from "../../../lib/utils";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useStableCallback } from "../../../hooks/useStableCallback";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { Toggle } from "../../ui/toggle";
import { PiNativeModelAdvancedSettings } from "./PiNativeModelAdvancedSettings";
import {
  filterBindings,
  filterModelInfos,
  hasBinding,
  mergeLookupEnrichment,
  moveListEntry,
  setVisibleBindings,
  toggleBinding,
} from "./piNativeModels.logic";

const CAPABILITY_FILTERS: ReadonlyArray<{ readonly value: ModelFilter; readonly label: string }> = [
  { value: "reasoning", label: msg("Reasoning") },
  { value: "vision", label: msg("Vision") },
  { value: "tools", label: msg("Tools") },
  { value: "pdf", label: msg("PDF") },
];

export type PiNativeProbeStatus = "idle" | "loading" | "ready" | "error";

export interface PiNativeProbeState {
  readonly status: PiNativeProbeStatus;
  readonly models: ReadonlyArray<PiNativeModelInfo>;
  readonly warning?: string | undefined;
  readonly error?: string | undefined;
}

const IDLE_PROBE: PiNativeProbeState = { status: "idle", models: [] };

export type ModelsUpdater = (
  updater: (current: ReadonlyArray<PiNativeModelBinding>) => ReadonlyArray<PiNativeModelBinding>,
) => void;

function CapabilityBadges(props: { readonly info: PiNativeModelInfo }) {
  const gt = useGT();
  const info = props.info;
  const badges: string[] = [];
  if (info.reasoning || (info.supportedThinkingLevels?.length ?? 0) > 0) {
    badges.push(gt("Reasoning"));
  }
  if (info.inputModalities.includes("image")) badges.push(gt("Vision"));
  if (info.inputModalities.includes("pdf")) badges.push(gt("PDF"));
  if (badges.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {badges.map((badge) => (
        <Badge key={badge} size="sm" variant="secondary">
          {badge}
        </Badge>
      ))}
    </span>
  );
}

function PaneHeading(props: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <h4 className="min-w-0 truncate text-xs font-medium text-foreground">{props.title}</h4>
      {props.count === undefined ? null : (
        <span className="shrink-0 rounded-sm bg-muted px-1 text-2xs tabular-nums text-muted-foreground">
          {props.count}
        </span>
      )}
      <div className="ms-auto flex shrink-0 items-center gap-1">{props.action}</div>
    </div>
  );
}

export function PiNativeModelSelectionPanes(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly apiStyle: PiNativeApiStyle;
  readonly vendorKey: string;
  readonly baseUrl: string;
  readonly apiKey: SettingsSecretValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly canProbe: boolean;
  readonly models: ReadonlyArray<PiNativeModelBinding>;
  readonly disabled?: boolean;
  /** A freshly added named preset picks its recommended models once. */
  readonly autoRecommend: boolean;
  readonly onModelsChange: ModelsUpdater;
  readonly onAdoptBaseUrl: (effectiveBaseUrl: string, resolvedFrom: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const probeModels = useAtomCommand(serverEnvironment.piNativeProbeModels, {
    reportFailure: false,
  });
  const lookupModel = useAtomCommand(serverEnvironment.piNativeLookupModel, {
    reportFailure: false,
  });
  const [probe, setProbe] = useState<{
    readonly key: string;
    readonly state: PiNativeProbeState;
  }>();
  const [modelQuery, setModelQuery] = useState("");
  const [chosenQuery, setChosenQuery] = useState("");
  const [filters, setFilters] = useState<ReadonlyArray<ModelFilter>>([]);
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const autoRecommendRef = useRef(props.autoRecommend);
  const requestKeyRef = useRef("");

  const disabled = props.disabled === true;
  const requestKey = [
    props.apiStyle,
    props.baseUrl,
    JSON.stringify(props.apiKey),
    props.instanceId ?? "",
    JSON.stringify(props.headers),
  ].join("|");
  const state = probe?.key === requestKey ? probe.state : IDLE_PROBE;
  const probeStatus = state.status;
  const probeModelList = state.models;

  const runProbe = useStableCallback(async (key: string) => {
    setProbe({ key, state: { status: "loading", models: [] } });
    const result = await probeModels({
      environmentId: props.environmentId,
      input: {
        apiStyle: props.apiStyle,
        baseUrl: props.baseUrl,
        ...(props.apiKey === "" ? {} : { apiKey: props.apiKey }),
        ...(props.instanceId === undefined ? {} : { instanceId: props.instanceId }),
        ...(props.vendorKey.trim() === "" ? {} : { vendorKey: props.vendorKey }),
        ...(Object.keys(props.headers).length === 0 ? {} : { headers: props.headers }),
      },
    });
    if (requestKeyRef.current !== key) return;
    if (result._tag !== "Success") {
      setProbe({
        key,
        state: {
          status: "error",
          models: [],
          error:
            thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
            gt("The model list could not be read."),
        },
      });
      return;
    }
    const value = result.value;
    if (value.resolvedFrom !== undefined) {
      props.onAdoptBaseUrl(value.effectiveBaseUrl, value.resolvedFrom);
    }
    setProbe({
      key,
      state: {
        status: "ready",
        models: value.models,
        ...(value.warning === undefined ? {} : { warning: value.warning }),
      },
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces the model-list probe timer against the typed endpoint
  useEffect(() => {
    requestKeyRef.current = requestKey;
    if (!props.canProbe || props.baseUrl.trim() === "") return;
    const timer = window.setTimeout(() => void runProbe(requestKey), 400);
    return () => window.clearTimeout(timer);
  }, [requestKey, props.canProbe, props.baseUrl, runProbe]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seeds the recommended models once the first probe answers
  useEffect(() => {
    if (!autoRecommendRef.current || probeStatus !== "ready" || probeModelList.length === 0) {
      return;
    }
    autoRecommendRef.current = false;
    if (props.models.length > 0) return;
    const recommended = recommendModelsForService(probeModelList, props.vendorKey || undefined);
    if (recommended.length > 0) props.onModelsChange(() => recommended);
  }, [probeStatus, probeModelList, props]);

  const stopAutoRecommend = () => {
    autoRecommendRef.current = false;
  };

  const visibleModels = filterModelInfos(state.models, modelQuery, filters);
  const selectedIds = new Set(props.models.map((binding) => binding.id.toLowerCase()));
  const visibleSelectedCount = visibleModels.filter((model) =>
    selectedIds.has(model.modelId.toLowerCase()),
  ).length;
  const allVisibleSelected =
    visibleModels.length > 0 && visibleSelectedCount === visibleModels.length;

  const toggleFilter = (filter: ModelFilter) => {
    setFilters((current) =>
      current.includes(filter) ? current.filter((entry) => entry !== filter) : [...current, filter],
    );
  };

  const toggleModel = (info: PiNativeModelInfo) => {
    stopAutoRecommend();
    props.onModelsChange((current) => toggleBinding(current, bindingFromModelInfo(info)));
  };

  const toggleVisibleModels = (select: boolean) => {
    stopAutoRecommend();
    const visible = visibleModels.map((info) => bindingFromModelInfo(info));
    props.onModelsChange((current) => setVisibleBindings(current, visible, select));
  };

  const removeBinding = (id: string) => {
    stopAutoRecommend();
    props.onModelsChange((current) => current.filter((binding) => binding.id !== id));
  };

  const moveBinding = (id: string, direction: -1 | 1) => {
    stopAutoRecommend();
    props.onModelsChange((current) => {
      const from = current.findIndex((binding) => binding.id === id);
      if (from === -1) return current;
      return moveListEntry(current, from, from + direction);
    });
  };

  const updateBinding = (id: string, update: Partial<PiNativeModelBinding>) => {
    props.onModelsChange((current) =>
      current.map((binding) => (binding.id === id ? { ...binding, ...update } : binding)),
    );
  };

  const addCustomModel = () => {
    const id = customModelId.trim();
    if (id === "") {
      setCustomModelError(gt("Enter a model ID."));
      return;
    }
    if (hasBinding(props.models, id)) {
      setCustomModelError(gt("This model is already selected."));
      return;
    }
    const discovered = state.models.find(
      (model) => model.modelId.toLowerCase() === id.toLowerCase(),
    );
    const seed = discovered
      ? { ...bindingFromModelInfo(discovered), id }
      : bindingForCustomModel(id);
    stopAutoRecommend();
    props.onModelsChange((current) => [...current, seed]);
    setCustomModelId("");
    setCustomModelError("");
    setExpandedId(id);
    if (discovered !== undefined) return;
    void (async () => {
      const result = await lookupModel({
        environmentId: props.environmentId,
        input: {
          modelId: id,
          ...(props.vendorKey.trim() === "" ? {} : { vendorKey: props.vendorKey }),
        },
      });
      if (result._tag !== "Success" || result.value.model === null) return;
      const enriched = bindingForCustomModel(id, result.value.model);
      // The lookup answers late; only fields the user has not touched adopt it.
      props.onModelsChange((current) =>
        current.map((binding) =>
          binding.id === id ? mergeLookupEnrichment(binding, enriched) : binding,
        ),
      );
    })();
  };

  const chosen = filterBindings(props.models, chosenQuery);

  const reload = (
    <Button
      type="button"
      size="xs"
      variant="ghost-muted"
      disabled={disabled || !props.canProbe || state.status === "loading"}
      onClick={() => void runProbe(requestKey)}
    >
      <RefreshCwIcon className={cn("size-3.5", state.status === "loading" && "animate-spin")} />
      {state.status === "loading" ? gt("Loading") : gt("Reload")}
    </Button>
  );

  return (
    <div className="grid min-h-0 gap-3 md:grid-cols-2">
      <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-background/40 p-2.5">
        <PaneHeading title={gt("Available models")} action={reload} />
        <div className="relative">
          <Input
            size="compact"
            value={modelQuery}
            spellCheck={false}
            placeholder={gt("Search models")}
            aria-label={gt("Search models")}
            onChange={(event) => setModelQuery(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {CAPABILITY_FILTERS.map((filter) => (
            <Toggle
              key={filter.value}
              size="segmented"
              variant="outline"
              pressed={filters.includes(filter.value)}
              aria-label={gt("Show only {capability} models", { capability: m(filter.label) })}
              onPressedChange={() => toggleFilter(filter.value)}
            >
              {m(filter.label)}
            </Toggle>
          ))}
          <span className="ms-auto flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={disabled || visibleModels.length === 0}
              onClick={() => toggleVisibleModels(true)}
            >
              {gt("Select visible")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={disabled || visibleSelectedCount === 0}
              onClick={() => toggleVisibleModels(false)}
            >
              {gt("Clear visible")}
            </Button>
          </span>
        </div>

        <div className="@container min-h-40 flex-1 overflow-y-auto">
          {state.status === "loading" ? (
            <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
              <Spinner /> {gt("Reading the service model list")}
            </p>
          ) : state.status === "error" ? (
            <p className="px-1 py-6 text-xs text-destructive">{state.error}</p>
          ) : state.status === "idle" ? (
            <p className="px-1 py-6 text-xs text-muted-foreground">
              {props.canProbe
                ? gt("Enter a Base URL and a key to read this service's models.")
                : gt("Enter an API key to read this service's models.")}
            </p>
          ) : visibleModels.length === 0 ? (
            <p className="px-1 py-6 text-xs text-muted-foreground">
              {state.models.length === 0
                ? gt("This service listed no models. Add model IDs on the right.")
                : gt("No model matches this search.")}
            </p>
          ) : (
            <ul className="grid gap-0.5">
              {visibleModels.map((info) => {
                const checked = selectedIds.has(info.modelId.toLowerCase());
                return (
                  <li key={info.modelId}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50",
                        checked && "bg-accent/40",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggleModel(info)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs text-foreground">
                          {info.displayName || info.modelId}
                        </span>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {info.modelId}
                        </span>
                      </span>
                      <CapabilityBadges info={info} />
                      <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatTokenCount(info.contextWindow)} / {formatTokenCount(info.maxTokens)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {state.status === "ready" && state.warning ? (
          <p className="text-2xs text-warning-foreground">{state.warning}</p>
        ) : null}
        {visibleModels.length > 0 && !allVisibleSelected ? (
          <p className="text-2xs text-muted-foreground">
            {gt("{count} of {total} shown selected", {
              count: visibleSelectedCount,
              total: visibleModels.length,
            })}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-background/40 p-2.5">
        <PaneHeading title={gt("Selected models")} count={props.models.length} />
        <div className="relative">
          <Input
            size="compact"
            value={chosenQuery}
            spellCheck={false}
            disabled={props.models.length === 0}
            placeholder={gt("Filter selected models")}
            aria-label={gt("Filter selected models")}
            onChange={(event) => setChosenQuery(event.currentTarget.value)}
          />
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto">
          {props.models.length === 0 ? (
            <p className="px-1 py-6 text-xs text-muted-foreground">
              {gt("No models selected yet. Pick models on the left or add an ID below.")}
            </p>
          ) : chosen.length === 0 ? (
            <p className="px-1 py-6 text-xs text-muted-foreground">
              {gt("No selected model matches this filter.")}
            </p>
          ) : (
            <ul className="grid gap-1">
              {chosen.map((binding) => {
                const index = props.models.findIndex((entry) => entry.id === binding.id);
                const expanded = expandedId === binding.id;
                const info = state.models.find(
                  (model) => model.modelId.toLowerCase() === binding.id.toLowerCase(),
                );
                const advancedId = `pi-native-model-advanced-${binding.id}`;
                return (
                  <li key={binding.id} className="rounded-lg border border-border/50 bg-card/60">
                    <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1.5">
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={disabled || index === 0}
                        aria-label={gt("Move {model} up", { model: binding.id })}
                        onClick={() => moveBinding(binding.id, -1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={disabled || index === props.models.length - 1}
                        aria-label={gt("Move {model} down", { model: binding.id })}
                        onClick={() => moveBinding(binding.id, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-xs text-foreground">
                            {binding.alias?.trim() || binding.displayName || binding.id}
                          </span>
                          {index === 0 ? (
                            <Badge size="sm" variant="success">
                              {gt("Default")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {binding.id}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatTokenCount(binding.contextWindow)} /{" "}
                        {formatTokenCount(binding.maxTokens)}
                      </span>
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        aria-expanded={expanded}
                        aria-controls={advancedId}
                        aria-label={
                          expanded
                            ? gt("Hide {model} settings", { model: binding.id })
                            : gt("Show {model} settings", { model: binding.id })
                        }
                        onClick={() => setExpandedId(expanded ? null : binding.id)}
                      >
                        <ChevronDownIcon
                          className={cn("transition-transform", expanded && "rotate-180")}
                        />
                      </Button>
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={disabled}
                        aria-label={gt("Remove {model}", { model: binding.id })}
                        onClick={() => removeBinding(binding.id)}
                      >
                        <XIcon />
                      </Button>
                    </div>
                    {expanded ? (
                      <PiNativeModelAdvancedSettings
                        id={advancedId}
                        binding={binding}
                        info={info}
                        apiStyle={props.apiStyle}
                        disabled={disabled}
                        onChange={(update) => updateBinding(binding.id, update)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              value={customModelId}
              spellCheck={false}
              placeholder={gt("Add model ID")}
              aria-label={gt("Add model ID")}
              aria-invalid={customModelError !== ""}
              onChange={(event) => {
                setCustomModelId(event.currentTarget.value);
                if (customModelError !== "") setCustomModelError("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addCustomModel();
              }}
            />
            <Button type="button" size="compact" variant="outline" onClick={addCustomModel}>
              <PlusIcon className="size-3.5" />
              {gt("Add")}
            </Button>
          </div>
          {customModelError !== "" ? (
            <p className="text-2xs text-destructive">{customModelError}</p>
          ) : null}
          {!allVisibleSelected && visibleSelectedCount > 0 ? (
            <p className="flex items-center gap-1 text-2xs text-muted-foreground">
              <CheckIcon className="size-3" />
              {gt("Selected models keep their own limits, thinking levels and aliases.")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
