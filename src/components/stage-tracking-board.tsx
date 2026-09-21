import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiStageTrackingBoardItem } from "@/lib/core-api";

export function StageTrackingBoard({
  rows,
  pendingTagCode,
  onTap,
}: {
  /** Rows are rendered exactly as delivered by the server; no client filtering occurs. */
  rows: ApiStageTrackingBoardItem[];
  pendingTagCode?: string | null;
  onTap: (tagCode: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function tap(tagCode: string) {
    setMessage("");
    setError("");
    try {
      await onTap(tagCode);
      setMessage("Tap recorded. The board was refreshed from the server.");
    } catch {
      // The server deliberately keeps expected tap failures neutral. Do not
      // infer or claim a state change in the UI.
      setError("Tap could not be recorded. No movement was shown.");
    }
  }

  return (
    <section className="mt-6" aria-labelledby="stage-board-title">
      <h2 id="stage-board-title" className="text-xl font-bold">
        My stage board
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This board shows tag codes and their server-authorized current stage only.
      </p>
      {rows.length === 0 ? (
        <p className="mt-6 rounded-md border p-4 text-sm text-muted-foreground">
          No tags are currently at your authorized stage.
        </p>
      ) : (
        <ul className="mt-6 grid gap-3" aria-label="Stage tracking board">
          {rows.map((row) => (
            <li key={row.tagCode} className="rounded-lg border p-4">
              <p className="font-mono text-sm font-semibold">{row.tagCode}</p>
              {row.currentStage ? (
                <>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Current stage: <span className="font-medium text-foreground">{row.currentStage.name}</span>
                  </p>
                  <Button
                    className="mt-4"
                    type="button"
                    disabled={pendingTagCode === row.tagCode}
                    onClick={() => void tap(row.tagCode)}
                  >
                    {pendingTagCode === row.tagCode ? "Recording tap…" : "Record arrival tap"}
                  </Button>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Awaiting administrator placement. A tap cannot place this tag.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {message ? <p className="mt-4 text-sm font-semibold text-emerald-700">{message}</p> : null}
      {error ? <p className="mt-4 text-sm font-semibold text-destructive">{error}</p> : null}
    </section>
  );
}
