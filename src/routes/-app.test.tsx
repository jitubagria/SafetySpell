import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldEditor, PreviewNav } from "./app";
import type { ApiGuardianField } from "@/lib/core-api";

describe("FieldEditor component (/app)", () => {
  const bloodGroupField: ApiGuardianField = {
    catalogId: "field-bg",
    key: "blood_group",
    label: "Blood Group",
    value: "A+",
    provenance: "guardian_reported",
    visibility: "private",
    publicReleaseEligible: true,
  };

  const allergyField: ApiGuardianField = {
    catalogId: "field-allergy",
    key: "allergy",
    label: "Allergies",
    value: "Penicillin",
    provenance: "guardian_reported",
    visibility: "public",
    publicReleaseEligible: true,
  };

  const flagsField: ApiGuardianField = {
    catalogId: "field-flags",
    key: "condition_flags",
    label: "Condition Flags",
    value: ["diabetes"],
    provenance: "guardian_reported",
    visibility: "private",
    publicReleaseEligible: true,
  };

  it("renders select dropdown and triggers onUpdateField on selection change", async () => {
    const onUpdateField = vi.fn().mockResolvedValue(undefined);
    const onUpdateVisibility = vi.fn().mockResolvedValue(undefined);

    render(
      <FieldEditor
        field={bloodGroupField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("A+");

    fireEvent.change(select, { target: { value: "O+" } });
    expect(onUpdateField).toHaveBeenCalledWith(bloodGroupField, "O+");
  });

  it("renders notes textarea and triggers onUpdateField on blur if value changed", async () => {
    const onUpdateField = vi.fn().mockResolvedValue(undefined);
    const onUpdateVisibility = vi.fn().mockResolvedValue(undefined);

    render(
      <FieldEditor
        field={allergyField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("Penicillin");

    fireEvent.change(textarea, { target: { value: "Penicillin\nPeanuts" } });
    fireEvent.blur(textarea);

    expect(onUpdateField).toHaveBeenCalledWith(allergyField, "Penicillin\nPeanuts");
  });

  it("renders condition flags checkboxes and triggers onUpdateField on toggle", async () => {
    const onUpdateField = vi.fn().mockResolvedValue(undefined);
    const onUpdateVisibility = vi.fn().mockResolvedValue(undefined);

    render(
      <FieldEditor
        field={flagsField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    const diabetesCheckbox = screen.getByRole("checkbox", { name: /diabetes/i });
    expect(diabetesCheckbox).toBeChecked();

    const epilepsyCheckbox = screen.getByRole("checkbox", { name: /epilepsy/i });
    expect(epilepsyCheckbox).not.toBeChecked();

    fireEvent.click(epilepsyCheckbox);

    expect(onUpdateField).toHaveBeenCalledWith(
      flagsField,
      expect.arrayContaining(["diabetes", "epilepsy"]),
    );
  });

  it("toggles visibility state and triggers onUpdateVisibility", async () => {
    const user = userEvent.setup();
    const onUpdateField = vi.fn().mockResolvedValue(undefined);
    const onUpdateVisibility = vi.fn().mockResolvedValue(undefined);

    // Test private -> public trigger
    const { rerender } = render(
      <FieldEditor
        field={bloodGroupField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    expect(screen.getByText("Private")).toBeInTheDocument();
    const releaseBtn = screen.getByRole("button", { name: /RELEASE PUBLICLY/i });
    expect(releaseBtn).toBeEnabled();

    await user.click(releaseBtn);
    expect(onUpdateVisibility).toHaveBeenCalledWith(bloodGroupField);

    // Test public -> private state
    rerender(
      <FieldEditor
        field={allergyField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    expect(screen.getByText("Publicly released")).toBeInTheDocument();
    const makePrivateBtn = screen.getByRole("button", { name: /MAKE PRIVATE/i });
    expect(makePrivateBtn).toBeEnabled();

    await user.click(makePrivateBtn);
    expect(onUpdateVisibility).toHaveBeenCalledWith(allergyField);
  });

  it("disables release button when field has no value or is not public-eligible", () => {
    const onUpdateField = vi.fn().mockResolvedValue(undefined);
    const onUpdateVisibility = vi.fn().mockResolvedValue(undefined);

    const emptyField: ApiGuardianField = {
      ...bloodGroupField,
      value: "",
    };

    const { rerender } = render(
      <FieldEditor
        field={emptyField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    const btn = screen.getByRole("button", { name: /RELEASE PUBLICLY/i });
    expect(btn).toBeDisabled();

    // Ineligible field
    const ineligibleField: ApiGuardianField = {
      ...bloodGroupField,
      publicReleaseEligible: false,
    };

    rerender(
      <FieldEditor
        field={ineligibleField}
        pending={false}
        onUpdateField={onUpdateField}
        onUpdateVisibility={onUpdateVisibility}
      />,
    );

    expect(screen.getByText("Private — not public-capable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /RELEASE PUBLICLY/i })).toBeDisabled();
  });
});

describe("PreviewNav component (/app)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders mock navigation preview bar in development mode", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "development");
    render(<PreviewNav />);

    const nav = screen.getByTestId("preview-nav");
    expect(nav).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Wards")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("Alerts")).toBeInTheDocument();
  });

  it("strictly suppresses mock navigation bar in production mode", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "production");
    render(<PreviewNav />);

    expect(screen.queryByTestId("preview-nav")).toBeNull();
    expect(screen.queryByText("Alerts")).toBeNull();
  });
});
