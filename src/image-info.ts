/**
 * The type and pixel size of a PNG, JPEG or WebP image, read from its header.
 * Only these three types are served for run screenshots (the backend cleans
 * every upload to one of them). Width and height are left out when the header
 * does not carry them where expected.
 */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export type ImageInfo = {
  mimeType: ImageMimeType;
  width?: number;
  height?: number;
};

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sized(mimeType: ImageMimeType, width: number, height: number): ImageInfo {
  return width > 0 && height > 0 ? { mimeType, width, height } : { mimeType };
}

function png(b: Uint8Array): ImageInfo {
  if (b.length >= 24 && ascii(b, 12, 4) === "IHDR") return sized("image/png", be32(b, 16), be32(b, 20));
  return { mimeType: "image/png" };
}

function jpeg(b: Uint8Array): ImageInfo {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return { mimeType: "image/jpeg" };
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // image data or end: no frame header found
    const length = be16(b, i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && i + 8 < b.length) return sized("image/jpeg", be16(b, i + 7), be16(b, i + 5));
    if (length < 2) break;
    i += 2 + length;
  }
  return { mimeType: "image/jpeg" };
}

function webp(b: Uint8Array): ImageInfo {
  const chunk = b.length >= 16 ? ascii(b, 12, 4) : "";
  if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return sized("image/webp", le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const width = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const height = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return sized("image/webp", width, height);
  }
  if (chunk === "VP8X" && b.length >= 30) return sized("image/webp", 1 + le24(b, 24), 1 + le24(b, 27));
  return { mimeType: "image/webp" };
}

/** The image type from the bytes themselves, or null for anything else. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return png(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
  return null;
}
