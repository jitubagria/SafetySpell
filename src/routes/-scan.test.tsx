import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicScan, Route, ScanResult } from "./scan";
import type { ApiScanResponse } from "@/lib/core-api";

describe("ScanResult component", () => {
  it("renders unconfigured notice when isConfigured is false", () => {
    render(<ScanResult tag="SS-DEMO-0001" isConfigured={false} result={undefined} error={null} />);
    expect(screen.getByText("Local scan API is not configured.")).toBeInTheDocument();
  });

  it("renders prompt to open scan link when tag is missing", () => {
    render(<ScanResult tag="" isConfigured={true} result={undefined} error={null} />);
    expect(
      screen.getByText("Open a Rescue ID scan link to check its released information."),
    ).toBeInTheDocument();
  });

  it("renders unreachable notice on scan error", () => {
    render(
      <ScanResult
        tag="SS-DEMO-0001"
        isConfigured={true}
        result={undefined}
        error={new Error("Network failed")}
      />,
    );
    expect(screen.getByText("The scan service could not be reached.")).toBeInTheDocument();
  });

  it("renders unavailable notice when tag status is not available", () => {
    const unavailableResult: ApiScanResponse = {
      status: "tag_unavailable",
    };
    render(
      <ScanResult tag="SS-DEMO-0001" isConfigured={true} result={unavailableResult} error={null} />,
    );
    expect(screen.getByText("No public profile is available for this tag.")).toBeInTheDocument();
  });

  it("renders notice when tag has zero released fields", () => {
    const emptyFieldsResult: ApiScanResponse = {
      status: "available",
      fields: [],
    };
    render(
      <ScanResult tag="SS-DEMO-0001" isConfigured={true} result={emptyFieldsResult} error={null} />,
    );
    expect(screen.getByText("No information has been released for this tag.")).toBeInTheDocument();
  });

  it("renders released fields and the family-provided disclaimer", () => {
    const releasedResult: ApiScanResponse = {
      status: "available",
      category: "elderly",
      fields: [
        {
          key: "blood_group",
          label: "Blood Group",
          value: "B+",
          provenance: "guardian_reported",
        },
        {
          key: "age_band",
          label: "Age Band",
          value: "senior",
          provenance: "guardian_reported",
        },
        {
          key: "allergy",
          label: "Allergies",
          value: "Penicillin\nPeanuts",
          provenance: "guardian_reported",
        },
      ],
      disclaimer: "All information is family-provided and may be incomplete.",
    };

    render(
      <ScanResult tag="SS-DEMO-0001" isConfigured={true} result={releasedResult} error={null} />,
    );

    // Labels and values
    expect(screen.getByText("Blood Group")).toBeInTheDocument();
    expect(screen.getByText("B+")).toBeInTheDocument();
    expect(screen.getByText("Age Band")).toBeInTheDocument();
    expect(screen.getByText("Senior")).toBeInTheDocument();

    // Multi-line allergy list
    expect(screen.getByText("Allergies")).toBeInTheDocument();
    expect(screen.getByText("Penicillin")).toBeInTheDocument();
    expect(screen.getByText("Peanuts")).toBeInTheDocument();

    // Mandatory public disclaimer
    expect(
      screen.getByText("All information is family-provided and may be incomplete."),
    ).toBeInTheDocument();
  });
});

describe("PublicScan page controls & environment behavior", () => {
  function renderWithClient(ui: React.ReactElement) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders demo gate and mock CALL FAMILY action button in development mode", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "development");
    vi.spyOn(Route, "useSearch").mockReturnValue({ tag: "SS-DEMO-0001" });

    renderWithClient(<PublicScan />);

    expect(screen.getByTestId("demo-gate")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rescue ID demo" })).toBeInTheDocument();
    const demoButton = screen.getByRole("button", { name: /CALL FAMILY — DEMO ONLY/i });
    expect(demoButton).toBeInTheDocument();
    expect(screen.getByText("Demo only — does nothing yet.")).toBeInTheDocument();
  });

  it("strictly suppresses demo banner and unwired CALL FAMILY button in production mode", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "production");
    vi.spyOn(Route, "useSearch").mockReturnValue({ tag: "SS-DEMO-0001" });

    renderWithClient(<PublicScan />);

    // Honest title and banner absence
    expect(screen.queryByTestId("demo-gate")).toBeNull();
    expect(screen.getByRole("heading", { name: "Rescue ID" })).toBeInTheDocument();
    expect(screen.queryByText(/Rescue ID demo/i)).toBeNull();

    // Dead action button MUST be absent
    expect(screen.queryByRole("button", { name: /CALL FAMILY/i })).toBeNull();
    expect(screen.queryByTestId("demo-call-action")).toBeNull();
    expect(screen.queryByText(/Demo only — does nothing yet/i)).toBeNull();
  });
});
