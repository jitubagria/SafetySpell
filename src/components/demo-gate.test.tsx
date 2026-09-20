import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DemoGate } from "./demo-gate";

describe("DemoGate", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllEnvs();
  });

  it("renders the warning banner in development / default mode", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "development");
    render(<DemoGate />);

    const banner = screen.getByTestId("demo-gate");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("DEMO / PROTOTYPE — not for real emergencies");
  });

  it("renders the warning banner when VITE_ENVIRONMENT is not specified", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "");
    render(<DemoGate />);

    const banner = screen.getByTestId("demo-gate");
    expect(banner).toBeInTheDocument();
  });

  it("hides the banner completely when VITE_ENVIRONMENT is production", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "production");
    render(<DemoGate />);

    const banner = screen.queryByTestId("demo-gate");
    expect(banner).toBeNull();
  });
});
