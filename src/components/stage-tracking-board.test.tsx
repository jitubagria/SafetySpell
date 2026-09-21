import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageTrackingBoard } from "./stage-tracking-board";

describe("StageTrackingBoard", () => {
  it("renders only server-supplied tag code and current stage values", () => {
    render(
      <StageTrackingBoard
        rows={[{ tagCode: "SS-BOARD-001", currentStage: { id: "stage-1", name: "Reception" } }]}
        onTap={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("SS-BOARD-001")).toBeInTheDocument();
    expect(screen.getByText("Reception")).toBeInTheDocument();
    expect(screen.queryByText(/guardian|consent|allergy|condition/i)).toBeNull();
  });

  it("shows movement only after the real tap callback resolves", async () => {
    const user = userEvent.setup();
    const onTap = vi.fn().mockResolvedValue(undefined);
    render(
      <StageTrackingBoard
        rows={[{ tagCode: "SS-BOARD-002", currentStage: { id: "stage-2", name: "Triage" } }]}
        onTap={onTap}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Record arrival tap" }));
    expect(onTap).toHaveBeenCalledWith("SS-BOARD-002");
    expect(await screen.findByText("Tap recorded. The board was refreshed from the server.")).toBeInTheDocument();
  });

  it("does not render a tap control for an unplaced row", () => {
    render(
      <StageTrackingBoard
        rows={[{ tagCode: "SS-BOARD-003", currentStage: null }]}
        onTap={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText(/Awaiting administrator placement/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record arrival tap" })).toBeNull();
  });
});
