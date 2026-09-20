import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WardTagQr } from "./ward-tag-qr";

describe("WardTagQr", () => {
  const defaultWardLabel = "Aarav Sharma";
  const sampleTags = [
    { code: "SS-DEMO-0001", form: "silicone_band" },
    { code: "SS-DEMO-0002", form: "card" },
  ];

  it("renders loading state when pending is true", () => {
    render(<WardTagQr wardLabel={defaultWardLabel} tags={[]} pending={true} error={null} />);
    expect(screen.getByText(/Loading tags/i)).toBeInTheDocument();
  });

  it("renders error message when error is provided", () => {
    const error = new Error("Failed to load tags from server");
    render(<WardTagQr wardLabel={defaultWardLabel} tags={[]} pending={false} error={error} />);
    expect(screen.getByText("Failed to load tags from server")).toBeInTheDocument();
  });

  it("renders empty state message when tags array is empty", () => {
    render(<WardTagQr wardLabel={defaultWardLabel} tags={[]} pending={false} error={null} />);
    expect(screen.getByText(/No active tags for this ward yet/i)).toBeInTheDocument();
  });

  it("renders list of tags with formatted form labels and codes", () => {
    render(
      <WardTagQr wardLabel={defaultWardLabel} tags={sampleTags} pending={false} error={null} />,
    );

    expect(screen.getByText(/silicone band tag/i)).toBeInTheDocument();
    expect(screen.getByText("SS-DEMO-0001")).toBeInTheDocument();
    expect(screen.getByText(/card tag/i)).toBeInTheDocument();
    expect(screen.getByText("SS-DEMO-0002")).toBeInTheDocument();

    const generateButtons = screen.getAllByRole("button", { name: /generate qr/i });
    expect(generateButtons).toHaveLength(2);
  });

  it("opens the QR modal dialog when 'Generate QR' is clicked", async () => {
    const user = userEvent.setup();
    render(
      <WardTagQr wardLabel={defaultWardLabel} tags={sampleTags} pending={false} error={null} />,
    );

    const generateButtons = screen.getAllByRole("button", { name: /generate qr/i });
    await user.click(generateButtons[0]!);

    // Modal dialog
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    const inDialog = within(dialog);
    expect(inDialog.getByRole("heading", { name: /Rescue ID QR/i })).toBeInTheDocument();
    expect(
      inDialog.getByText(
        /Opens this tag's public scan page. No personal data is stored in the QR./i,
      ),
    ).toBeInTheDocument();

    // Ward label and backup code in modal
    expect(inDialog.getByText(defaultWardLabel)).toBeInTheDocument();
    expect(inDialog.getByText("SS-DEMO-0001")).toBeInTheDocument();
    expect(inDialog.getByText(/Backup code — usable if the QR is scratched/i)).toBeInTheDocument();

    // Action buttons in modal
    expect(inDialog.getByRole("button", { name: /PNG/i })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: /SVG/i })).toBeInTheDocument();
    expect(inDialog.getByRole("button", { name: /Print/i })).toBeInTheDocument();
  });
});
