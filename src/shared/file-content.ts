import { z } from "zod";

export const maxFileSize = 95 * 1024 * 1024;

export const fileContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "video/mp4",
  "video/webm",
]);
export type FileContentType = z.infer<typeof fileContentTypeSchema>;

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0xff, 0xd8])) return false;
  let offset = 2;
  let foundFrame = false;
  let foundScan = false;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0xd9) {
      return foundFrame && foundScan && offset === bytes.byteLength;
    }
    if (marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) return false;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) return false;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 8) return false;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (height === 0 || width === 0) return false;
      foundFrame = true;
    }
    offset += length;
    if (marker !== 0xda) continue;

    foundScan = true;
    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (bytes[offset] === 0xff) offset += 1;
      const scanMarker = bytes[offset];
      if (scanMarker === undefined) return false;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset -= 1;
      break;
    }
  }
  return false;
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return false;
  }
  let offset = 8;
  let chunks = 0;
  let foundImageData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32BigEndian(bytes, offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) return false;
    const type = ascii(bytes, offset + 4, 4);
    const expectedCrc = readUint32BigEndian(bytes, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      return false;
    }
    if (chunks === 0) {
      if (type !== "IHDR" || length !== 13) return false;
      if (
        readUint32BigEndian(bytes, offset + 8) === 0 ||
        readUint32BigEndian(bytes, offset + 12) === 0
      ) {
        return false;
      }
    }
    if (type === "IDAT") foundImageData = true;
    if (type === "IEND") {
      return length === 0 && foundImageData && chunkEnd === bytes.byteLength;
    }
    offset = chunkEnd;
    chunks += 1;
  }
  return false;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | undefined {
  let offset = start;
  while (offset < bytes.byteLength) {
    const length = bytes[offset]!;
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > bytes.byteLength) return undefined;
    offset += length;
  }
  return undefined;
}

function isGif(bytes: Uint8Array): boolean {
  const header = ascii(bytes, 0, 6);
  if ((header !== "GIF87a" && header !== "GIF89a") || bytes.byteLength < 14) {
    return false;
  }
  if (
    (bytes[6]! | (bytes[7]! << 8)) === 0 ||
    (bytes[8]! | (bytes[9]! << 8)) === 0
  ) {
    return false;
  }
  let offset = 13;
  if ((bytes[10]! & 0x80) !== 0) {
    offset += 3 * 2 ** ((bytes[10]! & 0x07) + 1);
  }
  let foundImage = false;
  while (offset < bytes.byteLength) {
    const block = bytes[offset]!;
    offset += 1;
    if (block === 0x3b) return foundImage && offset === bytes.byteLength;
    if (block === 0x21) {
      if (offset >= bytes.byteLength) return false;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (block !== 0x2c || offset + 9 > bytes.byteLength) return false;
    const packed = bytes[offset + 8]!;
    offset += 9;
    if ((packed & 0x80) !== 0) {
      offset += 3 * 2 ** ((packed & 0x07) + 1);
    }
    if (offset >= bytes.byteLength) return false;
    offset += 1;
    const next = skipGifSubBlocks(bytes, offset);
    if (next === undefined) return false;
    offset = next;
    foundImage = true;
  }
  return false;
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function isWebp(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    readUint32LittleEndian(bytes, 4) + 8 !== bytes.byteLength
  ) {
    return false;
  }
  let offset = 12;
  let foundImage = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32LittleEndian(bytes, offset + 4);
    const payload = offset + 8;
    const end = payload + length;
    if (end > bytes.byteLength) return false;
    if (type === "VP8 ") {
      const frameTag =
        bytes[payload]! |
        (bytes[payload + 1]! << 8) |
        (bytes[payload + 2]! << 16);
      const partitionLength = frameTag >>> 5;
      const width =
        (bytes[payload + 6]! | (bytes[payload + 7]! << 8)) & 0x3fff;
      const height =
        (bytes[payload + 8]! | (bytes[payload + 9]! << 8)) & 0x3fff;
      if (
        length < 10 ||
        (frameTag & 1) !== 0 ||
        partitionLength === 0 ||
        partitionLength > length - 3 ||
        bytes[payload + 3] !== 0x9d ||
        bytes[payload + 4] !== 0x01 ||
        bytes[payload + 5] !== 0x2a ||
        width === 0 ||
        height === 0
      ) {
        return false;
      }
      foundImage = true;
    } else if (type === "VP8L") {
      if (
        length <= 5 ||
        bytes[payload] !== 0x2f ||
        (bytes[payload + 4]! >>> 5) !== 0
      ) {
        return false;
      }
      foundImage = true;
    } else if (type === "VP8X") {
      if (length !== 10) return false;
    } else if (type === "ANMF") {
      if (length <= 24) return false;
      const frame = bytes.subarray(payload + 16, end);
      const frameFile = new Uint8Array(12 + frame.byteLength);
      frameFile.set([0x52, 0x49, 0x46, 0x46], 0);
      new DataView(frameFile.buffer).setUint32(4, frameFile.byteLength - 8, true);
      frameFile.set([0x57, 0x45, 0x42, 0x50], 8);
      frameFile.set(frame, 12);
      if (!isWebp(frameFile)) return false;
      foundImage = true;
    }
    offset = end + (length % 2);
  }
  return offset === bytes.byteLength && foundImage;
}

interface IsoBox {
  readonly type: string;
  readonly payloadStart: number;
  readonly end: number;
}

function parseIsoBoxes(bytes: Uint8Array): IsoBox[] | undefined {
  const boxes: IsoBox[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return undefined;
    let size = readUint32BigEndian(bytes, offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return undefined;
      const extendedSize = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerSize || offset + size > bytes.byteLength) return undefined;
    boxes.push({
      type: ascii(bytes, offset + 4, 4),
      payloadStart: offset + headerSize,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}

function isoBrands(bytes: Uint8Array, box: IsoBox): string[] | undefined {
  if (box.end - box.payloadStart < 8 || (box.end - box.payloadStart) % 4 !== 0) {
    return undefined;
  }
  const brands = [ascii(bytes, box.payloadStart, 4)];
  for (let offset = box.payloadStart + 8; offset < box.end; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  return brands;
}

function detectIsoContentType(bytes: Uint8Array): FileContentType | undefined {
  const boxes = parseIsoBoxes(bytes);
  const first = boxes?.[0];
  if (first?.type !== "ftyp") return undefined;
  const brands = isoBrands(bytes, first);
  if (brands === undefined) return undefined;
  const meta = boxes?.find(({ type }) => type === "meta");
  const movie = boxes?.find(({ type }) => type === "moov");
  const mediaData = boxes?.find(({ type }) => type === "mdat");
  if (brands.some((brand) => brand === "avif" || brand === "avis")) {
    if (
      meta === undefined ||
      mediaData === undefined ||
      mediaData.end - mediaData.payloadStart < 4 ||
      meta.end - meta.payloadStart <= 4
    ) {
      return undefined;
    }
    const metaBoxes = parseIsoBoxes(
      bytes.subarray(meta.payloadStart + 4, meta.end),
    );
    const metaTypes = new Set(metaBoxes?.map(({ type }) => type));
    return metaTypes.has("pitm") &&
      metaTypes.has("iloc") &&
      metaTypes.has("iinf") &&
      metaTypes.has("iprp")
      ? "image/avif"
      : undefined;
  }
  return brands.some((brand) => mp4Brands.has(brand)) &&
    movie !== undefined &&
    mediaData !== undefined &&
    mediaData.end > mediaData.payloadStart &&
    containsVideoTrack(bytes.subarray(movie.payloadStart, movie.end))
    ? "video/mp4"
    : undefined;
}

const mp4Brands = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
]);

function containsVideoTrack(movie: Uint8Array): boolean {
  const tracks = parseIsoBoxes(movie)?.filter(({ type }) => type === "trak");
  return (
    tracks?.some((track) => {
      const trackBytes = movie.subarray(track.payloadStart, track.end);
      const media = parseIsoBoxes(trackBytes)?.find(
        ({ type }) => type === "mdia",
      );
      if (media === undefined) return false;
      const mediaBytes = trackBytes.subarray(media.payloadStart, media.end);
      const handler = parseIsoBoxes(mediaBytes)?.find(
        ({ type }) => type === "hdlr",
      );
      return (
        handler !== undefined &&
        handler.end - handler.payloadStart >= 12 &&
        ascii(mediaBytes, handler.payloadStart + 8, 4) === "vide"
      );
    }) ?? false
  );
}

function mp4Signature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
  const size = readUint32BigEndian(bytes, 0);
  if (size < 16 || size > bytes.byteLength || size % 4 !== 0) return false;
  const brands = isoBrands(bytes, {
    type: "ftyp",
    payloadStart: 8,
    end: size,
  });
  return brands?.some((brand) => mp4Brands.has(brand)) ?? false;
}

interface EbmlInteger {
  readonly length: number;
  readonly unknown: boolean;
  readonly value: number;
}

interface WebmSegment {
  readonly payloadStart: number;
  readonly size: EbmlInteger;
}

function readEbmlInteger(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): EbmlInteger | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let marker = 0x80;
  let length = 1;
  while ((first & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.byteLength) return undefined;
  let value = keepMarker ? first : first & (marker - 1);
  let unknown = !keepMarker && value === marker - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!;
    unknown = unknown && bytes[offset + index] === 0xff;
  }
  return Number.isSafeInteger(value) ? { length, unknown, value } : undefined;
}

function readWebmSegment(bytes: Uint8Array): WebmSegment | undefined {
  const headerId = readEbmlInteger(bytes, 0, true);
  if (headerId?.value !== 0x1a45dfa3) return undefined;
  const headerSize = readEbmlInteger(bytes, headerId.length, false);
  if (headerSize === undefined || headerSize.unknown) return undefined;
  let offset = headerId.length + headerSize.length;
  const headerEnd = offset + headerSize.value;
  if (headerEnd > bytes.byteLength) return undefined;
  let webmDocument = false;
  while (offset < headerEnd) {
    const id = readEbmlInteger(bytes, offset, true);
    if (id === undefined) return undefined;
    offset += id.length;
    const size = readEbmlInteger(bytes, offset, false);
    if (size === undefined || size.unknown) return undefined;
    offset += size.length;
    const end = offset + size.value;
    if (end > headerEnd) return undefined;
    if (
      id.value === 0x4282 &&
      size.value === 4 &&
      ascii(bytes, offset, size.value) === "webm"
    ) {
      webmDocument = true;
    }
    offset = end;
  }
  const segmentId = readEbmlInteger(bytes, headerEnd, true);
  if (!webmDocument || segmentId?.value !== 0x18538067) return undefined;
  const segmentSize = readEbmlInteger(bytes, headerEnd + segmentId.length, false);
  if (segmentSize === undefined) return undefined;
  return {
    payloadStart: headerEnd + segmentId.length + segmentSize.length,
    size: segmentSize,
  };
}

function isWebm(bytes: Uint8Array): boolean {
  const segment = readWebmSegment(bytes);
  if (segment === undefined) return false;
  let segmentOffset = segment.payloadStart;
  const segmentEnd = segment.size.unknown
    ? bytes.byteLength
    : segmentOffset + segment.size.value;
  if (segmentOffset >= segmentEnd || segmentEnd !== bytes.byteLength) return false;

  let foundTracks = false;
  let foundCluster = false;
  while (segmentOffset < segmentEnd) {
    const id = readEbmlInteger(bytes, segmentOffset, true);
    if (id === undefined) return false;
    segmentOffset += id.length;
    const size = readEbmlInteger(bytes, segmentOffset, false);
    if (size === undefined) return false;
    segmentOffset += size.length;
    const end = size.unknown ? segmentEnd : segmentOffset + size.value;
    if (end > segmentEnd || end <= segmentOffset) return false;
    if (id.value === 0x1654ae6b) foundTracks = true;
    if (id.value === 0x1f43b675) foundCluster = true;
    segmentOffset = end;
  }
  return foundTracks && foundCluster;
}

export function detectVideoFileSignature(
  bytes: Uint8Array,
): "video/mp4" | "video/webm" | undefined {
  if (mp4Signature(bytes)) return "video/mp4";
  if (readWebmSegment(bytes) !== undefined) return "video/webm";
  return undefined;
}

export function detectFileContentType(
  bytes: Uint8Array,
): FileContentType | undefined {
  if (isJpeg(bytes)) return "image/jpeg";
  if (isPng(bytes)) return "image/png";
  if (isWebp(bytes)) return "image/webp";
  const isoContentType = detectIsoContentType(bytes);
  if (isoContentType !== undefined) return isoContentType;
  if (isGif(bytes)) return "image/gif";
  if (isWebm(bytes)) return "video/webm";
  return undefined;
}
