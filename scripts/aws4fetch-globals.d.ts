// aws4fetch names these browser aliases in its declarations. Bun provides the
// underlying web types without exporting the aliases globally.
type HeadersInit = Headers | Iterable<readonly [string, string]> | Record<string, string>;
type BodyInit =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | ReadableStream
  | URLSearchParams
  | string;
