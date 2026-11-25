import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, PanelRightOpenIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";

const TABLE_COPY_SERIALIZERS: Record<TableCopyFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

function TableCopyMenu({
  copied,
  copyLabel,
  onCopy,
}: {
  copied: boolean;
  copyLabel: string;
  onCopy: (format: TableCopyFormat) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button type="button" variant="ghost-muted" size="icon-xs" aria-label={copyLabel} />
              }
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{copyLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuItem onClick={() => onCopy("markdown")}>
          <T>Copy as Markdown</T>
        </MenuItem>
        <MenuItem onClick={() => onCopy("csv")}>
          <T>Copy as CSV</T>
        </MenuItem>
        <MenuItem onClick={() => onCopy("html")}>
          <T>Copy as HTML</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function getTableViewport(wrapper: HTMLDivElement | null): HTMLElement | null {
  return (
    wrapper
      ?.closest(".chat-markdown-table-container")
      ?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
  );
}

function syncStickyThumb(wrapper: HTMLDivElement | null, thumb: HTMLDivElement | null) {
  const viewport = getTableViewport(wrapper);
  if (!viewport || !wrapper || !thumb) return;

  const { scrollWidth, clientWidth, scrollLeft } = viewport;
  const overflowing = scrollWidth > clientWidth + 1;
  wrapper.style.display = overflowing ? "flex" : "none";
  if (!overflowing) return;

  const widthPct = Math.max((clientWidth / scrollWidth) * 100, 10);
  const maxScroll = scrollWidth - clientWidth;
  const ratio = maxScroll > 0 ? Math.min(Math.max(scrollLeft / maxScroll, 0), 1) : 0;
  const leftPct = ratio * (100 - widthPct);

  thumb.style.width = `${widthPct}%`;
  thumb.style.left = `${leftPct}%`;
}

/**
 * Sticky horizontal scrollbar synced with the table's ScrollArea viewport so
 * wide tables can be scrolled horizontally without scrolling to the bottom first.
 */
function StickyTableScrollbar() {
  const gt = useGT();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs sticky scrollbar DOM geometry and visibility with the external ScrollArea viewport
  useEffect(() => {
    const viewport = getTableViewport(wrapperRef.current);
    if (!viewport) return;

    const sync = () => syncStickyThumb(wrapperRef.current, thumbRef.current);
    sync();

    viewport.addEventListener("scroll", sync, { passive: true });

    const table = viewport.querySelector("table");
    const unobserve = observeResize(table ? [viewport, table] : viewport, sync);

    return () => {
      viewport.removeEventListener("scroll", sync);
      unobserve();
    };
  }, []);

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target === thumbRef.current) return;
    const viewport = getTableViewport(wrapperRef.current);
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbWidth = thumb.getBoundingClientRect().width;
    const usableWidth = trackRect.width - thumbWidth;
    if (usableWidth <= 0) return;

    const clickOffset = event.clientX - trackRect.left - thumbWidth / 2;
    const ratio = Math.min(Math.max(clickOffset / usableWidth, 0), 1);
    viewport.scrollLeft = ratio * (viewport.scrollWidth - viewport.clientWidth);
  };

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const viewport = getTableViewport(wrapperRef.current);
    if (!viewport) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      startX: event.clientX,
      startScrollLeft: viewport.scrollLeft,
    };
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const viewport = getTableViewport(wrapperRef.current);
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    const usableWidth = track.getBoundingClientRect().width - thumb.getBoundingClientRect().width;
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    if (usableWidth <= 0 || maxScroll <= 0) return;

    const deltaX = event.clientX - drag.startX;
    viewport.scrollLeft = drag.startScrollLeft + (deltaX / usableWidth) * maxScroll;
  };

  const handleThumbPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={wrapperRef}
      style={{ display: "none" }}
      className="sticky bottom-1 z-10 mt-1 items-center select-none"
      data-slot="table-sticky-scrollbar"
    >
      <div
        ref={trackRef}
        role="scrollbar"
        aria-orientation="horizontal"
        aria-label={gt("Scroll table horizontally")}
        onPointerDown={handleTrackPointerDown}
        className="relative h-3 w-full cursor-pointer rounded-full border border-border/50 bg-background/85 p-0.5 shadow-xs backdrop-blur-xs"
      >
        <div
          ref={thumbRef}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerEnd}
          onPointerCancel={handleThumbPointerEnd}
          className="absolute top-0.5 bottom-0.5 cursor-grab rounded-full bg-muted-foreground/55 transition-colors hover:bg-muted-foreground/80 active:cursor-grabbing"
        />
      </div>
    </div>
  );
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sheetTableRef = useRef<HTMLTableElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? gt("Copied") : gt("Copy table");
  const expandLabel = gt("Open table in side panel");

  const handleCopy = (format: TableCopyFormat, targetTable?: HTMLTableElement | null) => {
    const table = targetTable ?? containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
    );
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      <StickyTableScrollbar />
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end gap-0.5 select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={expandLabel}
                onClick={() => setSheetOpen(true)}
              />
            }
          >
            <PanelRightOpenIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <TableCopyMenu copied={copied} copyLabel={copyLabel} onCopy={handleCopy} />
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetPopup side="right" className="w-[min(92vw,72rem)] max-w-none">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 py-3.5 ps-5 pe-12">
            <SheetTitle>
              <T>Table</T>
            </SheetTitle>
            <TableCopyMenu
              copied={copied}
              copyLabel={copyLabel}
              onCopy={(format) => handleCopy(format, sheetTableRef.current)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-5 pt-3">
            <ScrollArea className="h-full w-full" scrollFade>
              <div className="chat-markdown chat-markdown-sheet-table">
                <table ref={sheetTableRef} {...props}>
                  {children}
                </table>
              </div>
            </ScrollArea>
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}
