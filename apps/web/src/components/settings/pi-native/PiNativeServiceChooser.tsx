import {
  PI_NATIVE_VENDOR_PRESETS,
  type PiNativeVendorPreset,
} from "@t3tools/client-runtime/pi-native-catalog";
import { useGT } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../../lib/utils";
import { normalizeProviderAccentColor } from "../../../providerInstances";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { filterVendorPresets } from "./piNativeModels.logic";

const TILE_SELECTOR = "[data-service-tile]";

function VendorSwatch(props: { readonly preset: PiNativeVendorPreset }) {
  const color = normalizeProviderAccentColor(props.preset.accentColor);
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 text-xs font-semibold text-foreground"
      style={color === undefined ? undefined : { backgroundColor: `${color}1f`, color }}
    >
      {props.preset.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PiNativeServiceChooser(props: {
  readonly disabled?: boolean;
  /** Vendor key of the service already configured, marked when the user returns. */
  readonly currentVendorKey?: string | undefined;
  readonly onPickCustom: () => void;
  readonly onPickPreset: (preset: PiNativeVendorPreset) => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const disabled = props.disabled === true;
  const presets = filterVendorPresets(query, PI_NATIVE_VENDOR_PRESETS);
  const customMatches =
    query.trim() === "" || "custom endpoint".includes(query.trim().toLowerCase());
  const nothingMatches = !customMatches && presets.length === 0;

  const tiles = () => [
    ...(gridRef.current?.querySelectorAll<HTMLButtonElement>(TILE_SELECTOR) ?? []),
  ];

  /** Left and right walk reading order; up and down pick the nearest tile in the row. */
  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const all = tiles();
    const index = all.indexOf(event.currentTarget);
    if (index === -1) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = all[index + 1];
    else if (event.key === "ArrowLeft") next = all[index - 1];
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const down = event.key === "ArrowDown";
      const origin = event.currentTarget.getBoundingClientRect();
      const originCenter = origin.left + origin.width / 2;
      let best = Number.POSITIVE_INFINITY;
      for (const tile of all) {
        const box = tile.getBoundingClientRect();
        const gap = down ? box.top - origin.bottom : origin.top - box.bottom;
        if (gap < -1) continue;
        const score = gap * 1000 + Math.abs(box.left + box.width / 2 - originCenter);
        if (score < best) {
          best = score;
          next = tile;
        }
      }
      if (next === undefined && !down) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
    } else return;
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  const tileClass = (active: boolean) =>
    cn(
      "flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-2 text-left outline-none transition-colors",
      "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      disabled && "pointer-events-none opacity-60",
      active && "border-primary/50 bg-accent/40",
    );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div>
        <Input
          ref={searchRef}
          nativeInput
          value={query}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={gt("Search services")}
          aria-label={gt("Search services")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (customMatches) {
                props.onPickCustom();
              } else if (presets[0] !== undefined) {
                props.onPickPreset(presets[0]);
              }
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              tiles()[0]?.focus();
            }
          }}
        />
      </div>

      <div ref={gridRef} className="min-h-0 max-h-[60vh] overflow-y-auto pe-1">
        {nothingMatches ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm text-muted-foreground">{gt("No service matches this search.")}</p>
            <Button type="button" size="compact" variant="outline" onClick={props.onPickCustom}>
              {gt("Use custom endpoint")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {customMatches ? (
              <button
                type="button"
                data-service-tile
                className={tileClass(false)}
                disabled={disabled}
                onKeyDown={onTileKeyDown}
                onClick={props.onPickCustom}
              >
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-md border border-dashed border-border bg-muted/40 text-muted-foreground"
                >
                  <PlusIcon className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{gt("Custom Endpoint")}</span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {gt("Any OpenAI, Anthropic or Gemini compatible URL")}
                  </span>
                </span>
              </button>
            ) : null}
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-service-tile
                className={tileClass(preset.vendorKey === props.currentVendorKey)}
                disabled={disabled}
                aria-current={preset.vendorKey === props.currentVendorKey ? "true" : undefined}
                onKeyDown={onTileKeyDown}
                onClick={() => props.onPickPreset(preset)}
              >
                <VendorSwatch preset={preset} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{preset.name}</span>
                  <span className="truncate text-2xs text-muted-foreground">{preset.baseUrl}</span>
                </span>
                <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-2xs text-muted-foreground">
                  {preset.apiStyle}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
