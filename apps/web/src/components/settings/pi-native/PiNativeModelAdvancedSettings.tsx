import {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  PI_NATIVE_API_STYLES,
  THINKING_LEVELS,
  bindingDefaultThinkingMenuLevels,
  formatTokenCount,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
  type ModelLimitSource,
  type PiNativeApiStyle,
  type PiNativeModelBinding,
  type PiNativeModelInfo,
  type SessionThinkingLevel,
  type ThinkingLevel,
} from "@t3tools/client-runtime/pi-native-catalog";
import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Toggle } from "../../ui/toggle";
import { clampModelAlias } from "./piNativeModels.logic";

const CONTEXT_PRESETS = CONTEXT_WINDOW_PRESETS;
const OUTPUT_PRESETS = MAX_OUTPUT_PRESETS;
const REASONING_STYLES: ReadonlySet<PiNativeApiStyle> = new Set([
  "openai-completions",
  "opencode-go",
]);

type TriState = "auto" | "on" | "off";

const TRI_STATE_VALUES: ReadonlySet<string> = new Set(["auto", "on", "off"]);

function toTriState(value: boolean | null | undefined): TriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
}

function fromTriState(value: string): boolean | null {
  return value === "on" ? true : value === "off" ? false : null;
}

function Field(props: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", props.className)}>
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      {props.children}
      {props.hint ? (
        <span className="text-2xs leading-snug text-muted-foreground">{props.hint}</span>
      ) : null}
    </div>
  );
}

function LimitSourceBadge(props: { readonly source: ModelLimitSource | undefined }) {
  const gt = useGT();
  const user = props.source === "user";
  return (
    <span
      className={cn(
        "rounded-sm px-1 py-px text-2xs",
        user ? "bg-warning/12 text-warning-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {user ? gt("User") : gt("Catalog")}
    </span>
  );
}

function TriStateSelect(props: {
  readonly label: string;
  readonly value: boolean | null | undefined;
  readonly disabled?: boolean;
  readonly options: ReadonlyArray<{ readonly value: TriState; readonly label: string }>;
  readonly onChange: (value: boolean | null) => void;
}) {
  return (
    <Select
      value={toTriState(props.value)}
      onValueChange={(next) => {
        if (next !== null && TRI_STATE_VALUES.has(next)) props.onChange(fromTriState(next));
      }}
      disabled={props.disabled === true}
    >
      <SelectTrigger size="compact" aria-label={props.label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function tokenDraft(value: number): string {
  return value > 0 ? String(value) : "";
}

function parseTokenDraft(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.replace(/[^\d]/gu, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function PiNativeModelAdvancedSettings(props: {
  readonly id: string;
  readonly binding: PiNativeModelBinding;
  readonly info: PiNativeModelInfo | undefined;
  readonly apiStyle: PiNativeApiStyle;
  readonly disabled?: boolean;
  readonly onChange: (update: Partial<PiNativeModelBinding>) => void;
}) {
  const gt = useGT();
  const { binding, info } = props;
  const disabled = props.disabled === true;
  const enabledLevels = sortThinkingLevels(binding.thinkingLevels);
  const defaultLevels = bindingDefaultThinkingMenuLevels(binding.thinkingLevels);
  const thinkingProtocol = binding.thinkingProtocol ?? info?.thinkingProtocol ?? "legacy";
  const reasoningOffered = REASONING_STYLES.has(props.apiStyle);

  const toggleLevel = (level: ThinkingLevel) => {
    const next = enabledLevels.includes(level)
      ? enabledLevels.filter((entry) => entry !== level)
      : sortThinkingLevels([...enabledLevels, level]);
    // Enabling a level on a binding with no default must promote one, or the
    // ladder would be unreachable from the composer.
    props.onChange({
      thinkingLevels: next,
      defaultThinkingLevel: resolveBindingDefaultThinkingLevel(binding.defaultThinkingLevel, next),
    });
  };

  const setDefaultLevel = (next: string | null) => {
    if (next !== null) props.onChange({ defaultThinkingLevel: next as SessionThinkingLevel });
  };

  return (
    <div id={props.id} className="grid gap-3 border-t border-border/50 bg-muted/15 px-3 py-3">
      <Field
        label={gt("Model alias")}
        hint={gt("Shown in model pickers instead of the wire ID. Up to 60 characters.")}
      >
        <Input
          size="compact"
          value={binding.alias ?? ""}
          disabled={disabled}
          spellCheck={false}
          placeholder={binding.displayName ?? binding.id}
          onChange={(event) =>
            props.onChange({ alias: clampModelAlias(event.currentTarget.value) || undefined })
          }
          aria-label={gt("Model alias")}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              {gt("Context window")}
              <LimitSourceBadge source={binding.contextWindowSource} />
            </span>
          }
        >
          <Input
            size="compact"
            inputMode="numeric"
            font="mono"
            value={tokenDraft(binding.contextWindow)}
            disabled={disabled}
            onChange={(event) =>
              props.onChange({
                contextWindow: parseTokenDraft(event.currentTarget.value, binding.contextWindow),
                contextWindowSource: "user",
              })
            }
            aria-label={gt("Context window tokens")}
          />
          <div className="flex flex-wrap gap-1">
            {CONTEXT_PRESETS.map((preset) => (
              <Toggle
                key={preset}
                size="segmented"
                variant="outline"
                pressed={binding.contextWindow === preset}
                disabled={disabled}
                aria-label={gt("Context window {tokens}", { tokens: formatTokenCount(preset) })}
                onPressedChange={() =>
                  props.onChange({ contextWindow: preset, contextWindowSource: "user" })
                }
              >
                {formatTokenCount(preset)}
              </Toggle>
            ))}
          </div>
        </Field>

        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              {gt("Max output")}
              <LimitSourceBadge source={binding.maxTokensSource} />
            </span>
          }
        >
          <Input
            size="compact"
            inputMode="numeric"
            font="mono"
            value={tokenDraft(binding.maxTokens)}
            disabled={disabled}
            onChange={(event) =>
              props.onChange({
                maxTokens: parseTokenDraft(event.currentTarget.value, binding.maxTokens),
                maxTokensSource: "user",
              })
            }
            aria-label={gt("Maximum output tokens")}
          />
          <div className="flex flex-wrap gap-1">
            {OUTPUT_PRESETS.map((preset) => (
              <Toggle
                key={preset}
                size="segmented"
                variant="outline"
                pressed={binding.maxTokens === preset}
                disabled={disabled}
                aria-label={gt("Max output {tokens}", { tokens: formatTokenCount(preset) })}
                onPressedChange={() =>
                  props.onChange({ maxTokens: preset, maxTokensSource: "user" })
                }
              >
                {formatTokenCount(preset)}
              </Toggle>
            ))}
          </div>
        </Field>
      </div>

      <Field
        label={gt("Supported thinking levels")}
        hint={gt("Leave every level off for a model that does not reason.")}
      >
        <div
          role="group"
          aria-label={gt("Supported thinking levels")}
          className="flex flex-wrap gap-1"
        >
          {THINKING_LEVELS.map((level) => (
            <Toggle
              key={level}
              size="segmented"
              variant="outline"
              pressed={enabledLevels.includes(level)}
              disabled={disabled}
              aria-label={gt("Thinking level {level}", { level })}
              onPressedChange={() => toggleLevel(level)}
            >
              {level}
            </Toggle>
          ))}
        </div>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={gt("Default thinking level")}
          hint={
            defaultLevels.length === 0 ? gt("Enable levels above to choose a default.") : undefined
          }
        >
          <Select
            value={binding.defaultThinkingLevel ?? ""}
            onValueChange={setDefaultLevel}
            disabled={disabled || defaultLevels.length === 0}
          >
            <SelectTrigger
              size="compact"
              aria-label={gt("Default thinking level")}
              className="w-full"
            >
              <SelectValue placeholder={gt("Not set")} />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {defaultLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level === "omit" ? gt("Auto (provider default)") : level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label={gt("Thinking protocol")}>
          <Select
            value={thinkingProtocol}
            onValueChange={(next) => {
              if (next === "legacy" || next === "adaptive") {
                props.onChange({ thinkingProtocol: next });
              }
            }}
            disabled={disabled}
          >
            <SelectTrigger size="compact" aria-label={gt("Thinking protocol")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="legacy">{gt("Legacy thinking budget")}</SelectItem>
              <SelectItem value="adaptive">{gt("Adaptive reasoning effort")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {reasoningOffered ? (
          <Field label={gt("Reasoning effort")}>
            <TriStateSelect
              label={gt("Reasoning effort")}
              value={binding.supportsReasoningEffort}
              disabled={disabled}
              onChange={(next) => props.onChange({ supportsReasoningEffort: next })}
              options={[
                { value: "auto", label: gt("Auto") },
                { value: "on", label: gt("Force enabled") },
                { value: "off", label: gt("Disabled") },
              ]}
            />
          </Field>
        ) : null}

        <Field label={gt("Image input")}>
          <TriStateSelect
            label={gt("Image input")}
            value={binding.supportsImages}
            disabled={disabled}
            onChange={(next) => props.onChange({ supportsImages: next })}
            options={[
              { value: "auto", label: gt("Follow catalog") },
              { value: "on", label: gt("Enabled") },
              { value: "off", label: gt("Disabled") },
            ]}
          />
        </Field>

        <Field label={gt("Document (PDF) input")}>
          <TriStateSelect
            label={gt("Document (PDF) input")}
            value={binding.supportsDocuments}
            disabled={disabled}
            onChange={(next) => props.onChange({ supportsDocuments: next })}
            options={[
              { value: "auto", label: gt("Follow catalog") },
              { value: "on", label: gt("Enabled") },
              { value: "off", label: gt("Disabled") },
            ]}
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <Checkbox
          checked={binding.availableForSubagents === true}
          disabled={disabled}
          onCheckedChange={(checked) => props.onChange({ availableForSubagents: checked === true })}
        />
        {gt("Available for subagents")}
      </label>

      <p className="text-2xs text-muted-foreground">
        {gt("Wire format")}:{" "}
        {PI_NATIVE_API_STYLES.find((style) => style.value === props.apiStyle)?.label ??
          props.apiStyle}
      </p>
    </div>
  );
}
