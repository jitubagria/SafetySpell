import { useRef, useState } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Download, LoaderCircle, Printer, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type ApiWardTag, publicScanBaseUrl, scanUrlForTag } from "@/lib/core-api";

const QR_LEVEL = "H" as const;

function formLabel(form: string): string {
  return form.replaceAll("_", " ");
}

/** Section listing a ward's active tags, each with a Generate QR action. */
export function WardTagQr({
  wardLabel,
  tags,
  pending,
  error,
}: {
  wardLabel: string;
  tags: ApiWardTag[];
  pending: boolean;
  error: Error | null;
}) {
  const [openTag, setOpenTag] = useState<ApiWardTag | null>(null);

  if (!publicScanBaseUrl)
    return (
      <p className="text-sm text-muted-foreground">
        Set <code>VITE_PUBLIC_SCAN_BASE_URL</code> to generate scan QR codes.
      </p>
    );

  return (
    <div className="grid gap-3">
      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> Loading tags
        </p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-destructive">{error.message}</p> : null}
      {!pending && !error && !tags.length ? (
        <p className="text-sm text-muted-foreground">No active tags for this ward yet.</p>
      ) : null}
      {tags.map((tag) => (
        <div
          key={tag.code}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
        >
          <div>
            <p className="font-bold capitalize">{formLabel(tag.form)} tag</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{tag.code}</p>
          </div>
          <Button variant="outline" size="sm" type="button" onClick={() => setOpenTag(tag)}>
            <QrCode /> Generate QR
          </Button>
        </div>
      ))}

      <Dialog open={Boolean(openTag)} onOpenChange={(open) => !open && setOpenTag(null)}>
        <DialogContent className="max-w-md">
          {openTag ? <QrPanel wardLabel={wardLabel} tag={openTag} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QrPanel({ wardLabel, tag }: { wardLabel: string; tag: ApiWardTag }) {
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const scanUrl = scanUrlForTag(tag.code) ?? "";

  function serializedSvg(): string | null {
    const node = svgWrapRef.current?.querySelector("svg");
    if (!node) return null;
    return new XMLSerializer().serializeToString(node);
  }

  function triggerDownload(href: string, filename: string) {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadSvg() {
    const svg = serializedSvg();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], {
      type: "image/svg+xml",
    });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `safetyspell-${tag.code}.svg`);
    URL.revokeObjectURL(url);
  }

  function downloadPng() {
    const canvas = canvasWrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    triggerDownload(canvas.toDataURL("image/png"), `safetyspell-${tag.code}.png`);
  }

  function print() {
    const svg = serializedSvg();
    if (!svg) return;
    // A hidden same-document iframe, not window.open: popup blockers can silently kill a
    // popup, and printing the tag is the one action that puts it into the real world — it
    // must not fail quietly. Printing the iframe's own window isolates output to the QR sheet.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    iframe.srcdoc = `<!doctype html><html><head><title>SafetySpell Rescue ID</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; color: #111; }
  .sheet { display: flex; min-height: 100vh; flex-direction: column; align-items: center;
    justify-content: center; gap: 16px; padding: 32px; text-align: center; }
  svg { width: 260px; height: 260px; }
  .code { font-family: ui-monospace, monospace; font-size: 14px; word-break: break-all; }
  .label { font-size: 18px; font-weight: 700; }
  .hint { font-size: 12px; color: #555; }
  @page { margin: 12mm; }
</style></head><body><div class="sheet">
  ${svg}
  <div class="label">${escapeHtml(wardLabel)}</div>
  <div class="code">${escapeHtml(tag.code)}</div>
  <div class="hint">If the QR is damaged, use this code at the SafetySpell scan page.</div>
</div></body></html>`;
    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        iframe.remove();
        return;
      }
      const cleanup = () => window.setTimeout(() => iframe.remove(), 500);
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
      // Fallback removal in case afterprint never fires (e.g. print cancelled without event).
      window.setTimeout(() => iframe.remove(), 60000);
    };
    document.body.appendChild(iframe);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rescue ID QR</DialogTitle>
        <DialogDescription>
          Opens this tag&apos;s public scan page. No personal data is stored in the QR.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-5">
          <div ref={svgWrapRef}>
            <QRCodeSVG value={scanUrl} size={220} level={QR_LEVEL} marginSize={2} />
          </div>
          <p className="text-center text-lg font-bold text-black">{wardLabel}</p>
          <p className="break-all text-center font-mono text-sm text-neutral-700">{tag.code}</p>
          <p className="text-center text-xs text-neutral-500">
            Backup code — usable if the QR is scratched.
          </p>
        </div>
        {/* Hidden high-resolution canvas backs the PNG export. */}
        <div ref={canvasWrapRef} className="sr-only" aria-hidden>
          <QRCodeCanvas value={scanUrl} size={1024} level={QR_LEVEL} marginSize={2} />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Button variant="outline" type="button" onClick={downloadPng}>
            <Download /> PNG
          </Button>
          <Button variant="outline" type="button" onClick={downloadSvg}>
            <Download /> SVG
          </Button>
          <Button type="button" onClick={print}>
            <Printer /> Print
          </Button>
        </div>
      </div>
    </>
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
