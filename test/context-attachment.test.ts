import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import { imageInfo } from "../src/image-info.js";
import { createServer } from "../src/server.js";
import {
  ATTACHMENT_SAFETY_NOTICE,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
} from "../src/tools/attachments.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const ATTACHMENT_ID = "6f1c2a9e-0b7d-4c55-9a21-3e8f4d2b1c07";
const PATH = `/api/v1/incidents/16/investigation-attachments/${ATTACHMENT_ID}`;

/** A PNG header (signature and IHDR) of the given size, padded to bytes. */
function png(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 (length 17: precision, height, width, ...).
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, ...Array(12).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", payload: number[]): Uint8Array {
  const head = [..."RIFF"].map((c) => c.charCodeAt(0));
  const out = [...head, 0, 0, 0, 0, ..."WEBP".split("").map((c) => c.charCodeAt(0)), ...chunk.split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...payload];
  return new Uint8Array(out);
}

function imageResponse(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      ETag: `"${sha}"`,
      "Content-Disposition": 'inline; filename="checkout latency.png"',
      ...headers,
    },
  });
}

describe("image header", () => {
  it("reads the type and pixel size of PNG, JPEG and WebP", () => {
    expect(imageInfo(png(1280, 720))).toEqual({ mimeType: "image/png", width: 1280, height: 720 });
    expect(imageInfo(jpeg(640, 480))).toEqual({ mimeType: "image/jpeg", width: 640, height: 480 });
    // VP8: frame tag (3 bytes), start code, 14-bit width and height.
    expect(imageInfo(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x04, 0x00, 0x03]))).toEqual({
      mimeType: "image/webp",
      width: 1024,
      height: 768,
    });
    // VP8L: signature, then width-1 and height-1 packed in 14 bits each (99 x 49).
    const w = 99 - 1;
    const h = 49 - 1;
    const bits = w | (h << 14);
    expect(imageInfo(webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]))).toEqual({
      mimeType: "image/webp",
      width: 99,
      height: 49,
    });
    // VP8X: flags (4 bytes), then 24-bit width-1 and height-1.
    expect(imageInfo(webp("VP8X", [0, 0, 0, 0, 0xff, 0x07, 0x00, 0x37, 0x04, 0x00]))).toEqual({
      mimeType: "image/webp",
      width: 2048,
      height: 1080,
    });
  });

  it("knows the type without a size and refuses anything else", () => {
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ mimeType: "image/jpeg" });
    expect(imageInfo(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageInfo(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(imageInfo(new Uint8Array())).toBeNull();
  });
});

describe("TellagenClient.getBinary", () => {
  const client = new TellagenClient({ apiUrl: "https://test.api.tellagen.com/", apiKey: "tllg_test" });
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends the API key and Accept, and returns the bytes and headers", async () => {
    const bytes = png(10, 10);
    fetchSpy.mockResolvedValueOnce(imageResponse(bytes, { "Content-Type": "image/png; charset=binary" }));
    const out = await client.getBinary(PATH, { maxBytes: 1024, accept: "image/png" });
    expect(fetchSpy).toHaveBeenCalledWith(`https://test.api.tellagen.com${PATH}`, {
      method: "GET",
      headers: { Authorization: "Bearer tllg_test", Accept: "image/png" },
    });
    expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
    expect(out.contentType).toBe("image/png");
    expect(out.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(out.contentDisposition).toContain("checkout latency.png");
  });

  it("refuses a body over the cap, whether or not its length is declared", async () => {
    fetchSpy.mockResolvedValueOnce(imageResponse(png(1, 1, 2048)));
    await expect(client.getBinary(PATH, { maxBytes: 1024 })).rejects.toMatchObject({ status: 413, code: "response_too_large" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(800));
        controller.close();
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 200, headers: { "Content-Type": "image/png" } }));
    await expect(client.getBinary(PATH, { maxBytes: 1024 })).rejects.toThrow("at most 1024");
  });

  it("reports an error status like the JSON calls do", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "not_found", message: "screenshot not found" }, 404));
    const err = await client.getBinary(PATH, { maxBytes: 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TellagenAPIError);
    expect(err).toMatchObject({ status: 404, code: "not_found", message: "screenshot not found" });
  });
});

describe("tellagen_get_context_attachment", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  type Content = { type: string; text?: string; data?: string; mimeType?: string };
  const call = async (input: Record<string, unknown>) => {
    const harness = createToolHarness();
    const result = (await harness.callTool("tellagen_get_context_attachment", input)) as unknown as {
      content: Content[];
      isError?: boolean;
    };
    const text = result.content.find((c) => c.type === "text")!.text!;
    return { result, details: JSON.parse(text) as Record<string, any> };
  };

  it("returns the image block and a text block with the temp file, size, type and pixel size", async () => {
    const bytes = png(1280, 720, 4096);
    fetchSpy.mockResolvedValueOnce(imageResponse(bytes));
    const { result, details } = await call({ url: PATH });

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://test.api.tellagen.com${PATH}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tllg_test" }) }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["image", "text"]);
    const image = result.content[0]!;
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data!, "base64").equals(Buffer.from(bytes))).toBe(true);

    expect(details).toMatchObject({
      incident_id: 16,
      attachment_id: ATTACHMENT_ID,
      content_type: "image/png",
      size_bytes: 4096,
      width: 1280,
      height: 720,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      filename: "checkout latency.png",
      image: "inline",
      safety_notice: ATTACHMENT_SAFETY_NOTICE,
    });
    expect(details.reason).toBeUndefined();
    expect(details.file).toMatch(new RegExp(`tellagen-attachments-[^/]+/${ATTACHMENT_ID}\\.png$`));
    expect(readFileSync(details.file).equals(Buffer.from(bytes))).toBe(true);
    expect(statSync(details.file).mode & 0o777).toBe(0o600);
    // The bytes are never repeated as base64 text.
    expect(result.content[1]!.text).not.toContain(image.data!.slice(0, 40));
  });

  it("sends only the text block when the image is over the inline cap, and says why", async () => {
    const bytes = png(4000, 3000, MAX_INLINE_IMAGE_BYTES + 1);
    fetchSpy.mockResolvedValueOnce(imageResponse(bytes));
    const { result, details } = await call({ incident_id: 16, attachment_id: ATTACHMENT_ID.toUpperCase() });
    expect(fetchSpy.mock.calls[0]![0]).toBe(`https://test.api.tellagen.com${PATH}`);
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
    expect(details).toMatchObject({ image: "not_inline", size_bytes: MAX_INLINE_IMAGE_BYTES + 1, width: 4000, height: 3000 });
    expect(details.reason).toContain("over the 700 KB");
    expect(statSync(details.file).size).toBe(MAX_INLINE_IMAGE_BYTES + 1);
  });

  it("never fetches anything but an attachment path with the API key", async () => {
    for (const url of [
      `https://evil.example${PATH}`,
      "/api/v1/incidents/16/findings",
      `${PATH}/../../auth/me`,
      `/api/v1/incidents/16/investigation-attachments/not-a-uuid`,
    ]) {
      const { result, details } = await call({ url });
      expect(result.isError, url).toBe(true);
      expect(details.message).toContain("attachments.items[].url");
    }
    expect((await call({})).details.message).toContain("Send url");
    expect((await call({ url: PATH, incident_id: 17 })).details.message).toContain("different incident");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says a missing screenshot is final and does not retry", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "not_found", message: "screenshot not found" }, 404));
    const { result, details } = await call({ url: PATH });
    expect(result.isError).toBe(true);
    expect(details).toMatchObject({ status: 404, code: "not_found" });
    expect(details.next).toContain("Do not retry");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that is not a PNG, JPEG or WebP image, or does not match its checksum", async () => {
    fetchSpy.mockResolvedValueOnce(
      imageResponse(new TextEncoder().encode("<svg/>"), { "Content-Type": "image/svg+xml" }),
    );
    expect((await call({ url: PATH })).details.message).toContain("not a PNG, JPEG or WebP");
    fetchSpy.mockResolvedValueOnce(imageResponse(png(2, 2), { ETag: `"${"0".repeat(64)}"` }));
    const mismatch = await call({ url: PATH });
    expect(mismatch.result.isError).toBe(true);
    expect(mismatch.details.message).toContain("do not match the checksum");
  });

  it("refuses a body larger than the backend ever serves", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array(16), { status: 200, headers: { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) } }),
    );
    const { result, details } = await call({ url: PATH });
    expect(result.isError).toBe(true);
    expect(details.code).toBe("response_too_large");
  });

  it("is listed by the server and its image block passes the MCP result schema", async () => {
    const server = createServer(new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" }));
    const client = new Client({ name: "test", version: "0.0.1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "tellagen_get_context_attachment");
    expect(tool?.description).toContain("One image per call");
    fetchSpy.mockResolvedValueOnce(imageResponse(png(8, 6)));
    const result = await client.callTool({ name: "tellagen_get_context_attachment", arguments: { url: PATH } });
    expect((result.content as Content[]).map((c) => c.type)).toEqual(["image", "text"]);
    expect(client.getInstructions()).toContain("tellagen_get_context_attachment");
  });
});

describe("pickup and start carry the run context", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
  const body = (index: number) => JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body));

  it("points the agent at the screenshots when the bundle lists them, and only then", async () => {
    const harness = createToolHarness();
    const items = [{ id: ATTACHMENT_ID, url: PATH, caption: "p99 by region" }];
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, pickup: { attachments: { safety_notice: "n", items } } }));
    const withShots = harness.json(await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" }));
    expect(withShots.mcp_hint).toContain("1 screenshot is attached");
    expect(withShots.mcp_hint).toContain("tellagen_get_context_attachment");
    expect(withShots.pickup.attachments.items).toEqual(items);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-2" }, pickup: {} }));
    const without = harness.json(await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-2" }));
    expect(without.mcp_hint).toBeUndefined();
    expect(body(0).protocol_capabilities).toContain("run_images_v1");
  });

  it("starts a follow-up with corrects_run_id and a question with question_finding_id", async () => {
    const harness = createToolHarness();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-2" } }, 201))
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-3" } }, 201));
    await harness.callTool("tellagen_start_investigation", { incident_id: 16, corrects_run_id: "run-1", question: "Did the fix hold?" });
    await harness.callTool("tellagen_start_investigation", { incident_id: 16, question_finding_id: 42 });
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://test.api.tellagen.com/api/v1/incidents/16/investigations");
    expect(body(0)).toMatchObject({ corrects_run_id: "run-1", question: "Did the fix hold?", execution_mode: "local" });
    expect(body(0).question_finding_id).toBeUndefined();
    expect(body(1)).toMatchObject({ question_finding_id: 42 });
    expect(body(1).corrects_run_id).toBeUndefined();
  });

  it("validates the follow-up fields", async () => {
    const harness = createToolHarness();
    const { z } = await import("zod");
    const schema = z.object(harness.getTool("tellagen_start_investigation").config.inputSchema as Record<string, any>);
    expect(schema.safeParse({ incident_id: 16, corrects_run_id: " " }).success).toBe(false);
    expect(schema.safeParse({ incident_id: 16, question_finding_id: 0 }).success).toBe(false);
    expect(schema.safeParse({ incident_id: 16, corrects_run_id: "run-1", question_finding_id: 3 }).success).toBe(true);
  });
});
