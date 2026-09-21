import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scanUrlForTag,
  CoreApiError,
  scanTag,
  writeField,
  setVisibility,
  claimTag,
  activateTag,
  withdrawPublicRelease,
  getConsentAudit,
  revokeAdminTag,
  login,
  listStageTrackingBoard,
  tapStageTrackingTag,
} from "./core-api";

describe("core-api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("scanUrlForTag", () => {
    it("generates the canonical public scan URL using the default or provided base URL", () => {
      const url = scanUrlForTag("SS-DEMO-0001", "https://safetyspell.example.com");
      expect(url).toBe("https://safetyspell.example.com/scan?tag=SS-DEMO-0001");
    });

    it("URL encodes opaque tag codes with special characters", () => {
      const url = scanUrlForTag("SS-TEST/123+456", "https://safetyspell.example.com");
      expect(url).toBe("https://safetyspell.example.com/scan?tag=SS-TEST%2F123%2B456");
    });

    it("returns undefined when base URL is empty", () => {
      const url = scanUrlForTag("SS-DEMO-0001", "");
      expect(url).toBeUndefined();
    });
  });

  describe("CoreApiError", () => {
    it("preserves status code and message", () => {
      const err = new CoreApiError("Unauthorized", 401);
      expect(err.message).toBe("Unauthorized");
      expect(err.status).toBe(401);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("API Client Calls", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("scanTag calls GET /v1/public/scan/:tagCode", async () => {
      const mockResponse = {
        status: "available",
        category: "medical",
        fields: [
          {
            key: "blood_group",
            label: "Blood Group",
            value: "O+",
            provenance: "guardian_reported",
          },
        ],
        disclaimer: "All information is family-provided.",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const res = await scanTag("SS-DEMO-0001");
      expect(res).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/public/scan/SS-DEMO-0001"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "application/json",
          }),
        }),
      );
    });

    it("throws CoreApiError with response message when server returns an error status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: "Tag not found" }),
      });

      await expect(scanTag("SS-NONEXISTENT")).rejects.toMatchObject({
        message: "Tag not found",
        status: 404,
      });
    });

    it("throws CoreApiError with status 0 on network fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network connection dropped"));

      await expect(scanTag("SS-FAIL")).rejects.toThrowError(
        "Could not reach the Core API. Check the connection and try again.",
      );
    });

    it("login posts credentials to /v1/auth/login and returns accessToken", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: "test-jwt-token" }),
      });

      const token = await login("guardian@example.com", "password123456");
      expect(token).toBe("test-jwt-token");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/auth/login"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "guardian@example.com", password: "password123456" }),
        }),
      );
    });

    it("loads the narrow internal stage board with authentication", async () => {
      const board = [{ tagCode: "SS-BOARD-001", currentStage: { id: "stage-1", name: "Reception" } }];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => board });

      await expect(listStageTrackingBoard("staff-token")).resolves.toEqual(board);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/stage-tracking/board"),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer staff-token" }) }),
      );
    });

    it("posts a real arrival tap with authentication", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

      await expect(tapStageTrackingTag("staff-token", "SS-BOARD-001")).resolves.toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/stage-tracking/tags/SS-BOARD-001/tap"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer staff-token" }),
        }),
      );
    });

    it("writeField sends PATCH with value and auth token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "updated" }),
      });

      const res = await writeField("fake-token", "ward-123", "catalog-456", "Asthma");
      expect(res).toEqual({ status: "updated" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/fields/catalog-456"),
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            Authorization: "Bearer fake-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ value: "Asthma" }),
        }),
      );
    });

    it("setVisibility sends PUT with visibility and auth token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "updated", visibility: "public" }),
      });

      const res = await setVisibility("fake-token", "ward-123", "catalog-456", "public");
      expect(res).toEqual({ status: "updated", visibility: "public" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/fields/catalog-456/visibility"),
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            Authorization: "Bearer fake-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ visibility: "public" }),
        }),
      );
    });

    it("claimTag sends POST with tagCode and pin", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, code: "SS-DEMO-0001", wardId: "ward-123" }),
      });

      const res = await claimTag("fake-token", "ward-123", "SS-DEMO-0001", "123456");
      expect(res).toEqual({ success: true, code: "SS-DEMO-0001", wardId: "ward-123" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/tags/claim"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tagCode: "SS-DEMO-0001", pin: "123456" }),
        }),
      );
    });

    it("activateTag sends POST to activate the claimed tag", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          code: "SS-DEMO-0001",
          status: "active",
          activatedAt: "2026-09-20T10:00:00Z",
        }),
      });

      const res = await activateTag("fake-token", "ward-123", "SS-DEMO-0001");
      expect(res).toEqual({
        success: true,
        code: "SS-DEMO-0001",
        status: "active",
        activatedAt: "2026-09-20T10:00:00Z",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/tags/SS-DEMO-0001/activate"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("withdrawPublicRelease sends POST to withdraw all public fields atomically", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "withdrawn", visibility: "private" }),
      });

      const res = await withdrawPublicRelease("fake-token", "ward-123");
      expect(res).toEqual({ status: "withdrawn", visibility: "private" });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/public-release/withdraw"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer fake-token" }),
        }),
      );
    });

    it("getConsentAudit sends GET to retrieve chronological audit records", async () => {
      const mockAudit = [
        {
          eventType: "public_release_withdrawn",
          createdAt: "2026-09-20T12:00:00Z",
        },
        {
          eventType: "visibility_changed",
          fieldKey: "blood_group",
          oldVisibility: "private",
          newVisibility: "public",
          createdAt: "2026-09-20T11:00:00Z",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAudit,
      });

      const res = await getConsentAudit("fake-token", "ward-123");
      expect(res).toEqual(mockAudit);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/app/wards/ward-123/consent-audit"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer fake-token" }),
        }),
      );
    });

    it("revokeAdminTag posts the exact encoded tag code with admin authentication", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: "SS-DEMO-0001", status: "revoked", alreadyRevoked: false }),
      });

      await expect(revokeAdminTag("admin-token", "SS-DEMO/0001")).resolves.toEqual({
        code: "SS-DEMO-0001",
        status: "revoked",
        alreadyRevoked: false,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/admin/tags/SS-DEMO%2F0001/revoke"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer admin-token" }),
        }),
      );
    });
  });
});
