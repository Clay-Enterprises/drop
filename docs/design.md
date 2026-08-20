# Drop design

Drop is a stateless publishing API and CLI at `drop.clay.sh`. Authenticated callers upload media and self-contained HTML documents. Anyone with the resulting unlisted URL can read the content.

This service is for convenient sharing, including proprietary material, but not secrets. URLs are the only read barrier and cannot retract copies made by browsers, GitHub, chat clients, or other downstream systems.

## Product contract

- Uploads are private and require an Upload Key.
- Reads are public and require an unguessable URL containing at least 192 bits of cryptographic randomness.
- Public URLs contain no filename, retention class, owner, timestamp, or media type.
- Files use `https://drop.clay.sh/files/<opaque-id>`.
- Docs use `https://drop.clay.sh/docs/<opaque-id>`.
- Files and Docs are immutable to everyone except the exact Upload Key that created them.
- Dropping the same normalized absolute local path again replaces its content at the same URL.
- Re-drops are guarded by API write ETags and fail on concurrent modification.
- Content is not cached by Drop. Direct browser refreshes observe the latest successful Re-drop.
- Downstream caches and copies are outside Drop's guarantees.

## Accepted content

Files may be JPEG, PNG, WebP, AVIF, GIF, MP4, or WebM. The server detects the format from the bytes and does not trust the filename or submitted `Content-Type`.

Docs are UTF-8, self-contained HTML communication documents no larger than 512 KiB. They follow the `html-communication` skill's structural and security rules. The v1 policy permits inline CSS, inline SVG, data or HTTPS media, inline classic scripts, and user-initiated external links. It rejects external or module scripts, inline event handlers, JavaScript URLs, forms, frames, embeds, objects, applets, meta refresh, linked CSS, local paths, private network URLs, storage, network requests from script, workers, and script-created popups.

All uploads have a hard 95 MiB limit after client-side processing.

## Retention

The Retention Classes are `7d`, `30d`, `90d`, and `keep`. New Drops default to `keep`.

A Re-drop preserves the existing Retention Class unless the caller supplies another one. Re-dropping content or changing retention resets the retention clock. Retention changes preserve the public URL.

Expiry is terminal. After automatic or explicit deletion, dropping the same local path creates a new Opaque ID and replaces its stale local binding. The old URL remains dead.

R2 lifecycle rules are not used for content expiry. Each content object stores `retention` and `expiresAt` metadata. A daily scheduled Worker lists that metadata and removes expired objects. To avoid deleting a concurrent Re-drop, the sweep conditionally replaces a candidate with a zero-byte tombstone using the listed ETag, then deletes the tombstone. A failed conditional write means the object changed and must survive that sweep.

Expiry is approximate and may occur up to one scheduled sweep after `expiresAt`.

## Cloudflare architecture

Drop uses one Worker and two R2 buckets:

```text
drop.clay.sh/api/*       Cloudflare Worker
drop.clay.sh/files/*     direct from public drop-content R2 bucket
drop.clay.sh/docs/*      direct from public drop-content R2 bucket

drop-content             public Files, Docs, and object metadata
drop-control             private Upload Key records
```

R2 is the only persistent server-side store. There is no database, KV namespace, queue, sidecar metadata object, backup, replica, recovery promise, or SLA. The R2 development URL is disabled.

Public reads support `GET`, `HEAD`, byte ranges, ETags, `If-None-Match`, and `Content-Length`. CORS is disabled. Files and Docs render inline.

Public reads expose R2's content ETag. Authenticated write responses expose a distinct random write ETag stored in the object's custom metadata. A content ETag can recur when a Re-drop restores earlier bytes, so CLI bindings use the write ETag for `If-Match`. The final R2 write also pins the observed upload time to reject simultaneous same-byte replacements atomically.

Cloudflare rules bypass caching for the entire hostname and apply `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow, noarchive`. Docs also receive the restrictive sandbox Content Security Policy defined by the HTML communication contract.

## Credentials

An Upload Key has the shape:

```text
drop_u_<credential-id>_<256-bit-secret>
```

The private control bucket contains one strongly consistent record per credential ID with the SHA-256 secret hash and creation time. The complete key is returned only when created. Keys have no names, scopes, expiry, recovery, disabled state, or rotation.

Authorization belongs to the exact Upload Key. Every content object stores its creator's credential ID. Another Upload Key cannot replace it. Revoking a key deletes its control record immediately and makes its existing Drops read-only until they expire or an administrator deletes them.

The Admin Key is a Worker secret with a distinct `drop_a_` prefix. It can inspect inventory, delete Drops, and create, list, or revoke Upload Keys. It cannot Re-drop content on behalf of an Upload Key.

## HTTP API

```text
POST   /api/files              create File
PUT    /api/files/:id          Re-drop File
PATCH  /api/files/:id          change File retention
DELETE /api/files/:id          Admin deletion
GET    /api/files              Admin inventory

POST   /api/docs               create Doc
PUT    /api/docs/:id           Re-drop Doc
PATCH  /api/docs/:id           change Doc retention
DELETE /api/docs/:id           Admin deletion
GET    /api/docs               Admin inventory
```

The unversioned API uses Bearer authentication. Upload bodies are raw bytes. `Drop-Retention` carries the Retention Class and standard `Content-Disposition` carries the original filename. A retention-only `PATCH` uses JSON. Conditional writes use `If-Match` with the API write ETag.

Creation returns `201 Created`, successful writes return `200 OK`, and deletion returns `204 No Content`. Successful write responses include the URL, kind, detected content type, size, retention, expiry, and ETag. Creation also sets `Location`.

Errors use a stable JSON envelope:

```json
{
  "error": {
    "code": "stale_object",
    "message": "The Drop changed since this client last observed it."
  }
}
```

The API uses `400` for malformed input, `401` for an invalid credential, `403` for the wrong Upload Key, `404` for a missing Drop, `409` for a stale ETag, `413` for an oversized body, `415` for unsupported media, and `422` for an invalid Doc. Errors never contain credential material or submitted content.

Admin inventory is cursor-paginated over R2. The CLI fetches pages and applies owner, kind, retention, and time filters locally.

## CLI

The standalone `drop` CLI supports:

```console
drop <path> [--retention 7d|30d|90d|keep] [--raw] [--json]
drop retention <path-or-url> <retention>
drop auth set
drop admin list [filters]
drop admin delete <url>
drop admin keys create
drop admin keys list
drop admin keys revoke <credential-id>
```

An `.html` extension, compared case-insensitively, selects Doc upload. Every other path selects File upload, subject to server validation.

Successful uploads print only the public URL to stdout. Diagnostics and media processing progress go to stderr. `--json` prints the complete response.

`DROP_UPLOAD_KEY` overrides the mode-`0600` user configuration written by `drop auth set`. `DROP_ADMIN_KEY` is separate. Credentials are never stored in local path bindings.

The CLI stores one atomic JSON binding record per normalized absolute path under `~/.local/state/drop/bindings/`. The record filename is the SHA-256 path hash and contains the original path, URL, kind, ETag, and Retention Class. Separate records prevent concurrent agents from losing unrelated updates. Corrupt state causes an explicit failure rather than silent replacement.

### Video processing

MP4 and WebM uploads are lossy by default. The CLI uses a locally installed `ffmpeg` to produce H.264 video with AAC audio in a fast-start MP4, bounded within 1920 by 1920 pixels, with unrelated metadata removed. `--raw` skips processing and requires an accepted MP4 or WebM input. If `ffmpeg` is unavailable for a processed video, the CLI fails with an installation hint. If the result remains above 95 MiB, the CLI reports its size and asks the caller to compress it more aggressively.

Images and GIFs are not transformed in v1.

## Skills

The public repository contains two ordinary Agent Skills:

```text
skills/drop/SKILL.md
skills/html-communication/SKILL.md
```

They are installed from the GitHub repository with `npx skills`. The repository contains no Codex plugin, Claude plugin, marketplace manifest, or other harness-specific packaging.

The Drop skill uses the installed CLI to publish supported artifacts. It documents curl as an explicit API alternative but never silently replaces CLI behavior with curl.

The revised HTML communication skill retains its existing document contract, writes the local HTML artifact, drops it immediately, and reports the public URL. Updating the same local path and invoking the skill again preserves that URL. It does not start a localhost server. If Drop credentials or the CLI are missing, it keeps the local artifact and reports the setup requirement.

## Distribution and dotfiles

The entire repository is public under the MIT license. GitHub Releases publish standalone CLI binaries for macOS ARM64/x64, Linux ARM64/x64, and Windows x64, SHA-256 checksums, a macOS/Linux installer, and a PowerShell installer. No npm or GitHub Package is published.

The dotfiles repository consumes `Clay-Enterprises/drop` as a pinned non-flake source, links both external skills, removes its old local HTML communication skill, and installs a pinned release binary with a fixed checksum.

## Implementation and tests

The repository is a single TypeScript package with `src/worker`, `src/cli`, and `src/shared`. Bun handles dependency installation, scripts, pure tests, CLI tests, and standalone compilation. Wrangler builds and deploys the Cloudflare Worker. Hono handles the HTTP boundary and Zod validates requests and configuration.

Tests use `bun test`. Pure modules and the CLI run directly under Bun. Worker integration tests start `wrangler dev --local` and exercise the real local `workerd` runtime and R2 bindings over HTTP. Tests cover credential parsing, media and Doc validation, Local Path Identity, creation, exact-key replacement authorization, stale ETags, retention changes, deletion, expiry races, CLI behavior, and release startup.

There is one production environment at `drop.clay.sh`. Automated tests never use production resources.

## Operations

Structured Worker logs contain timestamp, credential ID, resulting URL, kind, size, Retention Class, outcome, and status. They exclude bearer secrets, original filenames, and content. There is no custom log sink or application rate limiter in v1.

A guided bootstrap wizard creates the two R2 buckets, generates and stores the Admin Key without exposing it in shell history, deploys the Worker and cron trigger, guides the custom-domain and response-rule setup, creates the initial Upload Key, and configures the local CLI. It pauses for Cloudflare steps that require human interaction.

The initial delivery publishes `main` to the existing `Clay-Enterprises/drop` repository, creates a `v0.1.0` release, provisions and verifies `drop.clay.sh`, updates and pushes the dotfiles repository, and verifies File, video, Doc, Re-drop, retention, and expiry behavior.
