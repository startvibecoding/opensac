import type { ImageContent } from "./types.ts";

/**
 * Maps a point in the sent image coordinate space back to the original source
 * image coordinate space. Returns [x, y, ok].
 */
export function mapPointToOriginal(
  img: ImageContent,
  x: number,
  y: number,
): [number, number, boolean] {
  const width = img.width ?? 0;
  const height = img.height ?? 0;
  const originalWidth = img.originalWidth ?? 0;
  const originalHeight = img.originalHeight ?? 0;
  if (width <= 0 || height <= 0 || originalWidth <= 0 || originalHeight <= 0) {
    return [0, 0, false];
  }
  let sourceW = originalWidth;
  let sourceH = originalHeight;
  let offsetX = 0;
  let offsetY = 0;
  if (img.cropped) {
    const cropWidth = img.cropWidth ?? 0;
    const cropHeight = img.cropHeight ?? 0;
    if (cropWidth <= 0 || cropHeight <= 0) {
      return [0, 0, false];
    }
    sourceW = cropWidth;
    sourceH = cropHeight;
    offsetX = img.cropX ?? 0;
    offsetY = img.cropY ?? 0;
  }
  const scaleX = sourceW / width;
  const scaleY = sourceH / height;
  return [offsetX + x * scaleX, offsetY + y * scaleY, true];
}

/**
 * Maps a rectangle in sent image coordinates back to the original source image
 * coordinate space. Returns [x, y, width, height, ok].
 */
export function mapRectToOriginal(
  img: ImageContent,
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number, number, number, boolean] {
  const [x1, y1, ok] = mapPointToOriginal(img, x, y);
  if (!ok) return [0, 0, 0, 0, false];
  const [x2, y2, ok2] = mapPointToOriginal(img, x + width, y + height);
  if (!ok2) return [0, 0, 0, 0, false];
  return [x1, y1, x2 - x1, y2 - y1, true];
}

/**
 * Maps a point from a normalized coordinate space such as [0,1000] back to the
 * original source image coordinate space. Returns [x, y, ok].
 */
export function mapNormalizedPointToOriginal(
  img: ImageContent,
  x: number,
  y: number,
  max: number,
): [number, number, boolean] {
  const width = img.width ?? 0;
  const height = img.height ?? 0;
  if (max <= 0 || width <= 0 || height <= 0) {
    return [0, 0, false];
  }
  return mapPointToOriginal(img, (x / max) * width, (y / max) * height);
}

/**
 * Maps a rectangle from a normalized coordinate space such as [0,1000] back to
 * the original source image coordinate space.
 * Returns [x, y, width, height, ok].
 */
export function mapNormalizedRectToOriginal(
  img: ImageContent,
  x: number,
  y: number,
  width: number,
  height: number,
  max: number,
): [number, number, number, number, boolean] {
  const imgWidth = img.width ?? 0;
  const imgHeight = img.height ?? 0;
  if (max <= 0 || imgWidth <= 0 || imgHeight <= 0) {
    return [0, 0, 0, 0, false];
  }
  return mapRectToOriginal(
    img,
    (x / max) * imgWidth,
    (y / max) * imgHeight,
    (width / max) * imgWidth,
    (height / max) * imgHeight,
  );
}
