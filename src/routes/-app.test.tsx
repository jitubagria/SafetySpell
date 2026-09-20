import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ConsentAuditTimeline,
  ConsentWithdrawalPanel,
  FieldEditor,
  formatFieldKey,
  PreviewNav,
  TagLifecyclePanel,
} from "./app";
import type { ApiConsentAuditEntry, ApiGuardianField } from "@/lib/core-api";

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

describe("TagLifecyclePanel component (/app)", () => {
  it("claims a tag and shows it ready for server-checked activation", async () => {
    const user = userEvent.setup();
    const onClaimTag = vi.fn().mockResolvedValue({ code: "SS-ABCD-EFGH" });
    const onActivateTag = vi.fn().mockResolvedValue({ code: "SS-ABCD-EFGH", status: "active" });
    const { rerender } = render(
      <TagLifecyclePanel
        assignedTags={[]}
        disabled={false}
        onClaimTag={onClaimTag}
        onActivateTag={onActivateTag}
      />,
    );

    await user.type(screen.getByLabelText("Tag code"), "ss-abcd-efgh");
    await user.type(screen.getByLabelText("One-time activation PIN"), "abc123");
    await user.click(screen.getByRole("button", { name: "CLAIM TAG" }));

    expect(onClaimTag).toHaveBeenCalledWith("SS-ABCD-EFGH", "ABC123");
    expect(await screen.findByText(/SS-ABCD-EFGH is claimed/i)).toBeInTheDocument();

    rerender(
      <TagLifecyclePanel
        assignedTags={[{ code: "SS-ABCD-EFGH", form: "band", status: "assigned" }]}
        disabled={false}
        onClaimTag={onClaimTag}
        onActivateTag={onActivateTag}
      />,
    );
    await user.click(screen.getByRole("button", { name: "ACTIVATE" }));

    expect(onActivateTag).toHaveBeenCalledWith("SS-ABCD-EFGH");
    expect(await screen.findByText(/SS-ABCD-EFGH is active/i)).toBeInTheDocument();
  });

  it("shows the server activation gate error without claiming the tag active", async () => {
    const user = userEvent.setup();
    const onActivateTag = vi
      .fn()
      .mockRejectedValue(
        new Error("Cannot activate tag: no public-released field contains profile data."),
      );
    render(
      <TagLifecyclePanel
        assignedTags={[{ code: "SS-ABCD-EFGH", form: "band", status: "assigned" }]}
        disabled={false}
        onClaimTag={vi.fn()}
        onActivateTag={onActivateTag}
      />,
    );

    await user.click(screen.getByRole("button", { name: "ACTIVATE" }));

    expect(
      await screen.findByText(/no public-released field contains profile data/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is active/i)).toBeNull();
  });
});

describe("ConsentWithdrawalPanel component (/app)", () => {
  it("keeps the withdraw button disabled until explicit confirmation checkbox is checked", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn().mockResolvedValue({ status: "withdrawn", visibility: "private" });

    render(
      <ConsentWithdrawalPanel disabled={false} publicFieldCount={2} onWithdraw={onWithdraw} />,
    );

    const withdrawBtn = screen.getByRole("button", { name: /WITHDRAW ALL PUBLIC RELEASES/i });
    expect(withdrawBtn).toBeDisabled();

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(withdrawBtn).toBeEnabled();

    await user.click(withdrawBtn);
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/All public disclosures have been withdrawn/i),
    ).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it("handles server failure honestly and does not display success notice", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi
      .fn()
      .mockRejectedValue(new Error("Database connection failure during atomic rollback"));

    render(
      <ConsentWithdrawalPanel disabled={false} publicFieldCount={1} onWithdraw={onWithdraw} />,
    );

    await user.click(screen.getByRole("checkbox"));
    const withdrawBtn = screen.getByRole("button", { name: /WITHDRAW ALL PUBLIC RELEASES/i });
    await user.click(withdrawBtn);

    expect(
      await screen.findByText(/Database connection failure during atomic rollback/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/All public disclosures have been withdrawn/i)).toBeNull();
  });
});

describe("ConsentAuditTimeline component (/app)", () => {
  it("renders honest empty state when no audit events exist", () => {
    render(<ConsentAuditTimeline auditEntries={[]} pending={false} error={null} />);

    expect(
      screen.getByText(/No consent modifications recorded for this ward yet/i),
    ).toBeInTheDocument();
  });

  it("renders chronological audit entries with readable field labels and appropriate badges", () => {
    const entries: ApiConsentAuditEntry[] = [
      {
        eventType: "public_release_withdrawn",
        createdAt: "2026-09-20T12:00:00Z",
      },
      {
        eventType: "visibility_changed",
        fieldKey: "blood_group",
        oldVisibility: "private",
        newVisibility: "public",
        createdAt: "2026-09-20T11:30:00Z",
      },
      {
        eventType: "visibility_changed",
        fieldKey: "allergy",
        oldVisibility: "public",
        newVisibility: "private",
        createdAt: "2026-09-20T11:00:00Z",
      },
    ];

    render(<ConsentAuditTimeline auditEntries={entries} pending={false} error={null} />);

    expect(screen.getByText("All public fields")).toBeInTheDocument();
    expect(screen.getByText("All public releases withdrawn")).toBeInTheDocument();

    expect(screen.getByText("Blood group")).toBeInTheDocument();
    expect(screen.getByText("Released publicly")).toBeInTheDocument();

    expect(screen.getByText("Allergies")).toBeInTheDocument();
    expect(screen.getByText("Set to private")).toBeInTheDocument();
  });

  it("renders loading and error states cleanly", () => {
    const { rerender } = render(
      <ConsentAuditTimeline auditEntries={[]} pending={true} error={null} />,
    );
    expect(screen.getByText(/Loading consent history/i)).toBeInTheDocument();

    rerender(
      <ConsentAuditTimeline
        auditEntries={[]}
        pending={false}
        error={new Error("Network timeout loading audit log")}
      />,
    );
    expect(screen.getByText(/Network timeout loading audit log/i)).toBeInTheDocument();
  });
});

describe("formatFieldKey", () => {
  it("formats known catalog field keys to readable human titles", () => {
    expect(formatFieldKey("age_band")).toBe("Age band");
    expect(formatFieldKey("primary_language")).toBe("Primary language");
    expect(formatFieldKey("blood_group")).toBe("Blood group");
    expect(formatFieldKey("allergy")).toBe("Allergies");
    expect(formatFieldKey("condition_flags")).toBe("Condition flags");
    expect(formatFieldKey("condition_notes")).toBe("Condition notes");
    expect(formatFieldKey(undefined)).toBe("All public fields");
  });
});
