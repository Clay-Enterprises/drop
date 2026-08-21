---
name: drop
description: Publish supported Files and Docs through the Drop CLI when the user wants a public Unlisted URL.
---

# Drop

Publish a local artifact as a File or Doc and return its Unlisted URL.

## Accepted artifacts

Drop accepts JPEG, PNG, WebP, AVIF, GIF, MP4, and WebM Files. It accepts self-contained UTF-8 Docs whose path ends in `.html`, case-insensitively. The service validates the bytes, so an extension does not make unsupported content valid.

The CLI processes MP4 and WebM video with FFmpeg by default. Use `--raw` only when the user asks to preserve accepted MP4 or WebM bytes.

## Publish with the CLI

1. Keep the artifact at its current path. The normalized absolute path is its Local Path Identity, so moving or copying it changes its identity.
2. Run `command -v drop`. If it fails, keep the local artifact and report exactly what is needed: install the Drop CLI and make sure `drop` is on `PATH`.
3. Run `drop <path>`, quoting the real path for the active shell. Add `--retention 7d`, `30d`, `90d`, or `keep` only when the user requests a Retention Class. Add `--raw` only for the video case above.
4. Return the Unlisted URL printed on stdout. An Unlisted URL is appropriate for proprietary material, but not secrets.

If the CLI reports that no Upload Key is configured, keep the local artifact and report the exact setup choices: run `drop auth set` or set `DROP_UPLOAD_KEY`. For any other failure, keep the artifact and report the CLI error. A failed CLI invocation never authorizes another upload method.

Running `drop` again with the same local path performs a Re-drop and preserves the live File or Doc URL. Expiry or explicit deletion is terminal, so the next drop at that path creates a new URL.

## Explicit raw curl alternative

Use raw curl only when the user explicitly requests the HTTP API or curl. Never silently substitute it when the CLI or its credentials are unavailable. Curl does not track Local Path Identity, so repeating a creation request creates a new Drop rather than a Re-drop.

For a File:

```sh
path=/absolute/path/to/file.png
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $DROP_UPLOAD_KEY" \
  -H "Content-Disposition: inline; filename=\"$(basename "$path")\"" \
  -H "Drop-Retention: keep" \
  --data-binary "@$path" \
  https://drop.clay.sh/api/files
```

For a Doc, use the same request with an `.html` path and `https://drop.clay.sh/api/docs`. The JSON response contains the Unlisted URL in `url`.
