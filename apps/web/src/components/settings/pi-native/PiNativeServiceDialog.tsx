import {
  isSecretReference,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PI_NATIVE_API_STYLES,
  PI_NATIVE_VENDOR_PRESETS,
  getBaseUrlIssue,
  normalizeBaseUrlInput,
  resolveEndpointDraft,
  type PiNativeApiStyle,
  type PiNativeModelBinding,
  type PiNativeVendorPreset,
} from "@t3tools/client-runtime/pi-native-catalog";
import { useGT } from "gt-react";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { m as resolveNow } from "../../../i18n/messages";
import { cn } from "../../../lib/utils";
import { normalizeProviderAccentColor } from "../../../providerInstances";
import { usePersistEnvironmentProviderInstanceMutation } from "../../../hooks/useSettings";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { ProviderAccentColorPicker } from "../ProviderAccentColorPicker";
import { SecretSourceInput, useSecretSources } from "../SecretSourceInput";
import { PiNativeModelSelectionPanes } from "./PiNativeModelSelectionPanes";
import { PiNativeServiceChooser } from "./PiNativeServiceChooser";
import {
  buildPiNativeConfig,
  buildPiNativeInstance,
  copyServiceDraft,
  copyServiceName,
  createEmptyHeaderPair,
  derivePiNativeInstanceId,
  hasStoredApiKey,
  headerNameIssue,
  pairsToRecord,
  presetForService,
  readPiNativeServiceConfig,
  recordToPairs,
  type HeaderPair,
  type PiNativeService,
  type PiNativeServiceConfig,
} from "./piNativeModels.logic";

export type PiNativeServiceDialogMode =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly service: PiNativeService }
  | { readonly kind: "copy"; readonly source: PiNativeService };

interface DialogSeed {
  readonly preset: PiNativeVendorPreset | undefined;
  readonly displayName: string;
  readonly config: PiNativeServiceConfig;
  readonly accentColor: string;
  readonly picked: boolean;
}

function seedFor(mode: PiNativeServiceDialogMode): DialogSeed {
  if (mode.kind === "create") {
    return {
      preset: undefined,
      displayName: "",
      config: readPiNativeServiceConfig(undefined),
      accentColor: "",
      picked: false,
    };
  }
  const service = mode.kind === "edit" ? mode.service : mode.source;
  const config = mode.kind === "edit" ? service : copyServiceDraft(service);
  // A shared vendorKey can back two presets (minimax-cn Anthropic and OpenAI),
  // so resolve through the service's endpoint and style rather than the key alone.
  const preset = presetForService(config);
  return {
    preset,
    displayName: mode.kind === "edit" ? service.displayName : copyServiceName(service.displayName),
    config,
    accentColor: service.instance.accentColor ?? "",
    picked: true,
  };
}

function SectionLabel(props: { readonly children: React.ReactNode }) {
  return <span className="text-xs font-medium text-foreground">{props.children}</span>;
}

export function PiNativeServiceDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly mode: PiNativeServiceDialogMode;
  readonly existingInstanceIds: ReadonlyArray<string>;
  readonly sortOrder: number | undefined;
  readonly readOnly?: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const seed = seedFor(props.mode);
  const secretSources = useSecretSources(props.environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    props.environmentId,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const testConnection = useAtomCommand(serverEnvironment.piNativeTestConnection, {
    reportFailure: false,
  });

  const [picked, setPicked] = useState(seed.picked);
  const [preset, setPreset] = useState<PiNativeVendorPreset | undefined>(seed.preset);
  const [displayName, setDisplayName] = useState(seed.displayName);
  const [baseUrl, setBaseUrl] = useState(seed.config.baseUrl);
  const [apiStyle, setApiStyle] = useState<PiNativeApiStyle>(seed.config.apiStyle);
  const [apiStyleTouched, setApiStyleTouched] = useState(
    props.mode.kind === "edit" || props.mode.kind === "copy",
  );
  const [apiKeyValue, setApiKeyValue] = useState<string | SettingsSecretValue>(
    props.mode.kind === "edit" && isSecretReference(seed.config.apiKey) ? seed.config.apiKey : "",
  );
  const [clearSavedKey, setClearSavedKey] = useState(false);
  const [accentColor, setAccentColor] = useState(seed.accentColor);
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>(() =>
    recordToPairs(seed.config.headers),
  );
  const [models, setModels] = useState<ReadonlyArray<PiNativeModelBinding>>(
    seed.config.modelBindings,
  );
  const [autoCompact, setAutoCompact] = useState(seed.config.autoCompact);
  const [infiniteRetry, setInfiniteRetry] = useState(seed.config.infiniteRetry);
  const [enableSubagents, setEnableSubagents] = useState(seed.config.enableSubagents);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { readonly kind: "ok"; readonly latencyMs: number; readonly modelCount?: number }
    | { readonly kind: "warning"; readonly message: string }
    | { readonly kind: "error"; readonly message: string }
    | undefined
  >();

  const disabled = props.readOnly === true;
  const endpoint = resolveEndpointDraft(baseUrl, apiStyle, apiStyleTouched);
  const resolvedApiStyle = endpoint.apiStyle;
  const baseUrlIssue = getBaseUrlIssue(baseUrl);
  const requestBaseUrl = normalizeBaseUrlInput(baseUrl, resolvedApiStyle);
  const headers = pairsToRecord(headerPairs);
  const originalApiKey: SettingsSecretValue =
    props.mode.kind === "edit" ? props.mode.service.apiKey : "";
  const savedKeyPresent =
    props.mode.kind === "edit" &&
    hasStoredApiKey(props.mode.service.apiKey) &&
    !clearSavedKey &&
    !isSecretReference(apiKeyValue) &&
    apiKeyValue.trim() === "";
  const literalDraft = typeof apiKeyValue === "string" ? apiKeyValue : "";
  const probeApiKey: SettingsSecretValue =
    clearSavedKey || savedKeyPresent
      ? ""
      : isSecretReference(apiKeyValue)
        ? apiKeyValue
        : literalDraft.trim();
  const instanceId: ProviderInstanceId =
    props.mode.kind === "edit"
      ? props.mode.service.instanceId
      : derivePiNativeInstanceId(
          preset?.vendorKey ?? seed.config.vendorKey,
          props.existingInstanceIds,
        );
  const canProbe =
    baseUrlIssue === undefined &&
    requestBaseUrl !== "" &&
    (preset === undefined ||
      literalDraft.trim() !== "" ||
      isSecretReference(apiKeyValue) ||
      savedKeyPresent ||
      props.mode.kind === "edit");
  // `custom` is a placeholder, not a models.dev vendor; never send it upstream.
  const activeVendorKey = preset?.vendorKey ?? seed.config.vendorKey;
  const requestVendorKey =
    activeVendorKey.trim() === "" || activeVendorKey === "custom" ? undefined : activeVendorKey;

  const applyPreset = (next: PiNativeVendorPreset | undefined) => {
    setPreset(next);
    setApiStyleTouched(false);
    if (next !== undefined) {
      setBaseUrl(next.baseUrl);
      setApiStyle(next.apiStyle);
      setApiKeyValue("");
      setClearSavedKey(false);
      setDisplayName((current) =>
        current.trim() === "" || PI_NATIVE_VENDOR_PRESETS.some((entry) => entry.name === current)
          ? next.name
          : current,
      );
      setAccentColor((current) =>
        normalizeProviderAccentColor(current) === undefined ? next.accentColor : current,
      );
      return;
    }
    // Back to a custom endpoint: drop whatever the previous preset seeded, but
    // keep a name or color the user typed for themselves.
    const previous = preset;
    setBaseUrl("");
    setApiStyle("openai-completions");
    setDisplayName((current) =>
      previous !== undefined && previous.name === current.trim() ? "" : current,
    );
    setAccentColor((current) =>
      previous !== undefined &&
      normalizeProviderAccentColor(current) === normalizeProviderAccentColor(previous.accentColor)
        ? ""
        : current,
    );
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(undefined);
    const result = await testConnection({
      environmentId: props.environmentId,
      input: {
        apiStyle: resolvedApiStyle,
        baseUrl: requestBaseUrl,
        ...(isSecretReference(apiKeyValue) ? { apiKey: apiKeyValue } : {}),
        ...(literalDraft.trim() === "" ? {} : { apiKey: literalDraft.trim() }),
        ...(savedKeyPresent ? { instanceId } : {}),
        ...(requestVendorKey === undefined ? {} : { vendorKey: requestVendorKey }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      },
    });
    setTesting(false);
    if (result._tag !== "Success") {
      setTestResult({
        kind: "error",
        message:
          thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
          gt("The connection test failed."),
      });
      return;
    }
    const value = result.value;
    if (!value.ok) {
      setTestResult({
        kind: "error",
        message: value.error ?? gt("The endpoint did not answer."),
      });
      return;
    }
    if (value.warning !== undefined) {
      setTestResult({ kind: "warning", message: value.warning });
      return;
    }
    setTestResult({
      kind: "ok",
      latencyMs: value.latencyMs,
      ...(value.modelCount === undefined ? {} : { modelCount: value.modelCount }),
    });
  };

  const save = async () => {
    if (disabled || saving) return;
    if (displayName.trim() === "" || requestBaseUrl === "" || baseUrlIssue !== undefined) return;
    if (models.length === 0) {
      toastManager.add({
        type: "warning",
        title: gt("Select at least one model"),
        description: gt("A Pi Native service needs one bound model before it can run."),
      });
      return;
    }
    const apiKey: SettingsSecretValue = clearSavedKey
      ? ""
      : isSecretReference(apiKeyValue)
        ? apiKeyValue
        : literalDraft.trim() !== ""
          ? literalDraft.trim()
          : originalApiKey;
    const config = buildPiNativeConfig({
      enabled: props.mode.kind === "edit" ? props.mode.service.enabled : true,
      vendorKey: preset?.vendorKey || seed.config.vendorKey || "custom",
      apiStyle: resolvedApiStyle,
      baseUrl: requestBaseUrl,
      apiKey,
      headers,
      modelBindings: models,
      sortOrder: props.mode.kind === "edit" ? props.mode.service.sortOrder : props.sortOrder,
      autoCompact,
      infiniteRetry,
      enableSubagents,
      customModels: seed.config.customModels,
    });
    const instance: ProviderInstanceConfig = buildPiNativeInstance({
      enabled: config.enabled,
      displayName: displayName.trim(),
      accentColor,
      config,
    });
    setSaving(true);
    const result = await persistProviderInstance({ operation: "upsert", instanceId, instance }, {});
    setSaving(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: gt("Could not save this service"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), resolveNow) ??
          gt("The settings update failed."),
      });
      return;
    }
    await refreshProviders({
      environmentId: props.environmentId,
      input: { refreshModels: true, reloadSecrets: true },
    });
    toastManager.add({
      type: "success",
      title: props.mode.kind === "edit" ? gt("Service updated") : gt("Service added"),
      description: gt("{name} now serves {count} models.", {
        name: displayName.trim(),
        count: models.length,
      }),
    });
    props.onSaved();
  };

  const testBanner = testResult ? (
    <p
      role="status"
      className={cn(
        "text-2xs",
        testResult.kind === "ok" && "text-success-foreground",
        testResult.kind === "warning" && "text-warning-foreground",
        testResult.kind === "error" && "text-destructive",
      )}
    >
      {testResult.kind === "ok"
        ? gt("Connected in {latency} ms{models}.", {
            latency: String(testResult.latencyMs),
            models:
              testResult.modelCount === undefined
                ? ""
                : gt(", {count} models listed", { count: testResult.modelCount }),
          })
        : testResult.message}
    </p>
  ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-5xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>
            {props.mode.kind === "edit"
              ? gt("Edit Pi Native service")
              : props.mode.kind === "copy"
                ? gt("Copy Pi Native service")
                : gt("Add Pi Native service")}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {gt("Services and their model catalogs are managed together in this workbench.")}
          </p>
        </DialogHeader>

        {picked ? (
          <DialogPanel>
            <div className="flex flex-wrap items-center gap-2">
              {preset === undefined ? (
                <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {gt("Custom endpoint")}
                </span>
              ) : (
                <>
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full border border-border/60"
                    style={{
                      backgroundColor:
                        normalizeProviderAccentColor(accentColor) ?? preset.accentColor,
                    }}
                  />
                  <span className="text-xs text-foreground">{preset.name}</span>
                </>
              )}
              {props.mode.kind === "edit" ? null : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  onClick={() => setPicked(false)}
                >
                  {gt("Change service")}
                </Button>
              )}
              <div className="ms-auto flex min-w-0 items-center gap-2">
                <Input
                  size="compact"
                  className="w-56"
                  value={displayName}
                  disabled={disabled || saving}
                  placeholder={preset?.name ?? gt("Service name")}
                  aria-label={gt("Service name")}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                />
                <ProviderAccentColorPicker
                  displayName={displayName.trim() || preset?.name || gt("Pi Native service")}
                  value={accentColor}
                  layout="inline"
                  onCommit={setAccentColor}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <SectionLabel>{gt("Base URL")}</SectionLabel>
                <Input
                  size="compact"
                  font="mono"
                  value={baseUrl}
                  disabled={disabled || saving}
                  spellCheck={false}
                  placeholder={preset?.baseUrl ?? "https://api.example.com/v1"}
                  aria-invalid={baseUrlIssue !== undefined}
                  aria-label={gt("Base URL")}
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                  onBlur={() => setBaseUrl(endpoint.baseUrl)}
                />
                {baseUrlIssue === undefined ? (
                  endpoint.autoDetected ? (
                    <p className="text-2xs text-muted-foreground">
                      {gt("Detected {style} from this URL.", {
                        style:
                          PI_NATIVE_API_STYLES.find((style) => style.value === resolvedApiStyle)
                            ?.label ?? resolvedApiStyle,
                      })}
                    </p>
                  ) : null
                ) : (
                  <p className="text-2xs text-destructive">{baseUrlIssue}</p>
                )}
              </div>

              <div className="grid gap-1.5">
                <SectionLabel>{gt("API style")}</SectionLabel>
                <Select
                  value={resolvedApiStyle}
                  onValueChange={(next) => {
                    setApiStyleTouched(true);
                    setApiStyle(next as PiNativeApiStyle);
                  }}
                  disabled={disabled || saving}
                >
                  <SelectTrigger size="compact" aria-label={gt("API style")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {PI_NATIVE_API_STYLES.map((style) => (
                      <SelectItem key={style.value} value={style.value}>
                        {style.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-1.5">
              <SectionLabel>{gt("API key")}</SectionLabel>
              <div className="flex min-w-0 items-start gap-2">
                <SecretSourceInput
                  size="compact"
                  aria-label={gt("API key")}
                  className="min-w-0 flex-1"
                  value={isSecretReference(apiKeyValue) ? apiKeyValue : literalDraft}
                  configured={savedKeyPresent}
                  sources={secretSources}
                  environmentId={props.environmentId}
                  disabled={disabled || saving}
                  placeholder={
                    preset === undefined
                      ? gt("Optional for local endpoints")
                      : gt("Paste the service key")
                  }
                  onCommit={(next) => {
                    setApiKeyValue(next);
                    if (next.trim() !== "") setClearSavedKey(false);
                  }}
                  onSecretChange={(secret) => {
                    setApiKeyValue(secret ?? "");
                    if (secret !== undefined) setClearSavedKey(false);
                  }}
                />
                {props.mode.kind === "edit" && hasStoredApiKey(props.mode.service.apiKey) ? (
                  <Button
                    type="button"
                    size="compact"
                    variant={clearSavedKey ? "outline" : "ghost-muted"}
                    disabled={disabled || saving}
                    onClick={() => {
                      setClearSavedKey((current) => !current);
                      setApiKeyValue("");
                    }}
                  >
                    {clearSavedKey ? gt("Use saved key") : gt("Clear saved key")}
                  </Button>
                ) : null}
              </div>
              <p className="text-2xs text-muted-foreground">
                {clearSavedKey
                  ? gt("This service will connect without a key.")
                  : savedKeyPresent
                    ? gt("A key is stored on the host. Enter a new one to replace it.")
                    : gt("Optional for local endpoints that need no credential.")}
              </p>
            </div>

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger
                render={
                  <Button type="button" size="compact" variant="ghost-muted" className="-ms-2">
                    <ChevronDownIcon
                      className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
                    />
                    {gt("Advanced connection")}
                  </Button>
                }
              />
              <CollapsiblePanel>
                <div className="grid gap-3 border-t border-border/50 pt-3">
                  <div className="grid gap-1.5">
                    <SectionLabel>{gt("Custom HTTP headers")}</SectionLabel>
                    <div className="grid gap-1.5">
                      {headerPairs.map((pair) => {
                        const issue = headerNameIssue(pair.name);
                        return (
                          <div key={pair.key} className="grid gap-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <Input
                                size="compact"
                                font="mono"
                                className="min-w-0 flex-1"
                                value={pair.name}
                                disabled={disabled || saving}
                                spellCheck={false}
                                placeholder={gt("Header name")}
                                aria-label={gt("Header name")}
                                aria-invalid={issue !== undefined}
                                onChange={(event) => {
                                  const name = event.currentTarget.value;
                                  setHeaderPairs((current) =>
                                    current.map((entry) =>
                                      entry.key === pair.key ? { ...entry, name } : entry,
                                    ),
                                  );
                                }}
                              />
                              <Input
                                size="compact"
                                font="mono"
                                className="min-w-0 flex-1"
                                value={pair.value}
                                disabled={disabled || saving}
                                spellCheck={false}
                                placeholder={gt("Value")}
                                aria-label={gt("Header value")}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setHeaderPairs((current) =>
                                    current.map((entry) =>
                                      entry.key === pair.key ? { ...entry, value } : entry,
                                    ),
                                  );
                                }}
                              />
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost-muted"
                                disabled={disabled || saving}
                                aria-label={gt("Remove header")}
                                onClick={() =>
                                  setHeaderPairs((current) =>
                                    current.filter((entry) => entry.key !== pair.key),
                                  )
                                }
                              >
                                <XIcon className="size-3.5" />
                              </Button>
                            </div>
                            {issue === undefined ? null : (
                              <p className="text-2xs text-destructive">
                                {gt("This header is not sent: {reason}", { reason: issue })}
                              </p>
                            )}
                          </div>
                        );
                      })}
                      <Button
                        type="button"
                        size="compact"
                        variant="ghost-muted"
                        className="w-fit"
                        disabled={disabled || saving}
                        onClick={() =>
                          setHeaderPairs((current) => [...current, createEmptyHeaderPair()])
                        }
                      >
                        <PlusIcon className="size-3.5" />
                        {gt("Add header")}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <label className="flex items-center justify-between gap-3 text-xs text-foreground">
                      {gt("Auto-compact")}
                      <Switch
                        checked={autoCompact}
                        disabled={disabled || saving}
                        onCheckedChange={setAutoCompact}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-xs text-foreground">
                      {gt("Infinite retry")}
                      <Switch
                        checked={infiniteRetry}
                        disabled={disabled || saving}
                        onCheckedChange={setInfiniteRetry}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-xs text-foreground">
                      {gt("Enable subagents")}
                      <Switch
                        checked={enableSubagents}
                        disabled={disabled || saving}
                        onCheckedChange={setEnableSubagents}
                      />
                    </label>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>

            <PiNativeModelSelectionPanes
              key={props.mode.kind === "edit" ? instanceId : (preset?.id ?? "custom")}
              environmentId={props.environmentId}
              instanceId={savedKeyPresent ? instanceId : undefined}
              apiStyle={resolvedApiStyle}
              vendorKey={requestVendorKey ?? ""}
              baseUrl={requestBaseUrl}
              apiKey={probeApiKey}
              headers={headers}
              canProbe={canProbe}
              models={models}
              disabled={disabled || saving}
              autoRecommend={props.mode.kind === "create" && preset !== undefined}
              onModelsChange={setModels}
              onAdoptBaseUrl={(effectiveBaseUrl, resolvedFrom) => {
                setBaseUrl((current) =>
                  normalizeBaseUrlInput(current, resolvedApiStyle) ===
                  normalizeBaseUrlInput(resolvedFrom, resolvedApiStyle)
                    ? effectiveBaseUrl
                    : current,
                );
              }}
            />
          </DialogPanel>
        ) : (
          <DialogPanel>
            <PiNativeServiceChooser
              disabled={disabled}
              onPickCustom={() => {
                applyPreset(undefined);
                setPicked(true);
              }}
              onPickPreset={(next) => {
                applyPreset(next);
                setPicked(true);
              }}
            />
          </DialogPanel>
        )}

        <DialogFooter className="sm:justify-between">
          {picked ? (
            <div className="flex min-w-0 flex-col gap-1">
              <Button
                type="button"
                size="compact"
                variant="outline"
                disabled={disabled || saving || testing || !canProbe}
                onClick={() => void runTest()}
              >
                {testing ? <Spinner /> : null}
                {testing ? gt("Testing") : gt("Test connection")}
              </Button>
              {testBanner}
            </div>
          ) : (
            <span />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              size="compact"
              variant="ghost"
              disabled={saving}
              onClick={props.onClose}
            >
              {gt("Cancel")}
            </Button>
            {picked ? (
              <Button
                type="button"
                size="compact"
                disabled={
                  disabled ||
                  saving ||
                  displayName.trim() === "" ||
                  requestBaseUrl === "" ||
                  baseUrlIssue !== undefined ||
                  models.length === 0
                }
                onClick={() => void save()}
              >
                {saving ? <Spinner /> : null}
                {saving ? gt("Saving") : gt("Save service")}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
