import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";

describe("TellagenClient", () => {
  const client = new TellagenClient({
    apiUrl: "https://test.api.tellagen.com",
    apiKey: "tllg_test123",
  });

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends GET with correct headers", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ incident: { id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.get("/api/v1/incidents/1");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://test.api.tellagen.com/api/v1/incidents/1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tllg_test123",
        }),
      }),
    );
    expect(result).toEqual({ incident: { id: 1 } });
  });

  it("sends POST with JSON body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ run: { id: "run-abc" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.post("/api/v1/incidents/1/investigations", {
      agent_name: "test",
      model_used: "claude-test",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://test.api.tellagen.com/api/v1/incidents/1/investigations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          agent_name: "test",
          model_used: "claude-test",
        }),
      }),
    );
    expect(result).toEqual({ run: { id: "run-abc" } });
  });

  it("sends PATCH with JSON body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ run: { status: "completed" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.patch("/api/v1/investigations/run-abc", {
      status: "completed",
    });

    expect(result).toEqual({ run: { status: "completed" } });
  });

  it("throws TellagenAPIError on 400", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "bad_request",
          message: "claim is required",
        }),
        { status: 400 },
      ),
    );

    await expect(client.get("/api/v1/findings/1")).rejects.toThrow(
      TellagenAPIError,
    );
  });

  it("throws TellagenAPIError on 401", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "unauthorized", message: "invalid API key" }),
        { status: 401 },
      ),
    );

    try {
      await client.get("/api/v1/auth/me");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TellagenAPIError);
      const apiErr = err as TellagenAPIError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.code).toBe("unauthorized");
    }
  });

  it("throws TellagenAPIError on 403 with scope error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: "missing scope: incidents:read",
        }),
        { status: 403 },
      ),
    );

    try {
      await client.get("/api/v1/incidents");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TellagenAPIError);
      const apiErr = err as TellagenAPIError;
      expect(apiErr.status).toBe(403);
    }
  });

  it("handles non-JSON error responses", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    try {
      await client.get("/api/v1/incidents");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TellagenAPIError);
      const apiErr = err as TellagenAPIError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe("Internal Server Error");
    }
  });

  it("strips trailing slashes from baseUrl", async () => {
    const c = new TellagenClient({
      apiUrl: "https://test.api.tellagen.com///",
      apiKey: "tllg_key",
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await c.get("/api/v1/incidents");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://test.api.tellagen.com/api/v1/incidents",
      expect.anything(),
    );
  });
});
