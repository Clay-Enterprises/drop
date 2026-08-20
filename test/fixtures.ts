const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const onePixelPng = Uint8Array.from(
  atob(onePixelPngBase64),
  (character) => character.charCodeAt(0),
);
