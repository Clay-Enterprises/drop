# Drop

Drop publishes supported media and self-contained HTML Docs at public, unlisted URLs. The service runs at `drop.clay.sh`; this repository contains its Cloudflare Worker, standalone CLI, installers, and Agent Skills.

An unlisted URL is a sharing control, not access control. Anyone with the URL can read and copy its content. Do not use Drop for secrets.

## Install the CLI

macOS and Linux:

```sh
curl --fail --silent --show-error --location \
  https://github.com/Clay-Enterprises/drop/releases/latest/download/install.sh | sh
```

The installer selects macOS ARM64/x64 or Linux ARM64/x64, downloads the matching binary and `SHA256SUMS`, verifies SHA-256, then writes `drop` to `${XDG_BIN_HOME:-$HOME/.local/bin}`. Set `DROP_INSTALL_DIR` to choose another user-writable directory.

Windows PowerShell:

```powershell
irm https://github.com/Clay-Enterprises/drop/releases/latest/download/install.ps1 | iex
```

The PowerShell installer supports Windows x64, verifies `SHA256SUMS`, and writes `drop.exe` under `%LOCALAPPDATA%\Programs\drop\bin` by default. Set `DROP_INSTALL_DIR` to choose another directory. Neither installer requests elevation.

Release assets are standalone binaries. Drop does not publish an npm package or GitHub Package. To verify a manual download, fetch `SHA256SUMS` from the same release and compare its entry with the binary's SHA-256 digest.

## Authenticate and use the CLI

Store an Upload Key with mode `0600` on macOS and Linux:

```console
drop auth set < upload-key.txt
```

`DROP_UPLOAD_KEY` overrides the stored key. Drop reads configuration from `$XDG_CONFIG_HOME/drop/config.json`, or `~/.config/drop/config.json` when `XDG_CONFIG_HOME` is unset. Local Path Identity bindings live under `$XDG_STATE_HOME/drop/bindings`, or `~/.local/state/drop/bindings`.

```console
drop image.png
drop demo.mp4 --retention 30d
drop report.html --json
drop retention report.html 90d
drop retention https://drop.clay.sh/docs/<opaque-id> keep
```

Dropping the same normalized absolute path again is a Re-drop. It replaces the content at the existing unlisted URL. Moving or copying the local path creates a new Drop. Expiry and explicit deletion are terminal.

The remaining commands are:

```console
drop --help
drop --version
drop admin list [--kind file|doc] [--retention 7d|30d|90d|keep] [--owner <credential-id>] [--before <time>] [--after <time>] [--json]
drop admin delete <url> [--json]
drop admin keys create [--json]
drop admin keys list [--json]
drop admin keys revoke <credential-id> [--json]
```

Admin commands require `DROP_ADMIN_KEY`. `DROP_API_URL` overrides the default API origin.

## Supported content and retention

Files may be JPEG, PNG, WebP, AVIF, GIF, MP4, or WebM. The service detects media from its bytes. File uploads have a 95 MiB limit after local processing. The CLI processes MP4 and WebM through FFmpeg by default; `--raw` preserves accepted video bytes.

Docs are UTF-8, self-contained HTML no larger than 512 KiB. They may use inline CSS, inline SVG, data or HTTPS media, and constrained inline classic scripts. The validator rejects network requests from scripts, browser storage, forms, frames, external scripts, local paths, and other capabilities listed in [the design](docs/design.md).

Retention Classes are `7d`, `30d`, `90d`, and `keep`. New Drops default to `keep`. A Re-drop preserves the current class unless the request supplies another one, and it resets the retention clock. A daily sweep deletes expired content, so deletion may occur up to one sweep after the nominal time.

## HTTP API and curl

The write API accepts bearer Upload Keys, raw request bodies, `Content-Disposition`, and an optional `Drop-Retention` header.

```text
POST /api/files
PUT /api/files/:id
PATCH /api/files/:id
POST /api/docs
PUT /api/docs/:id
PATCH /api/docs/:id
GET /api/files
DELETE /api/files/:id
GET /api/docs
DELETE /api/docs/:id
POST /api/admin/keys
GET /api/admin/keys
DELETE /api/admin/keys/:credential-id
POST /api/admin/sweep
GET /files/:id
HEAD /files/:id
GET /docs/:id
HEAD /docs/:id
```

Create a File with curl:

```sh
path=/absolute/path/to/image.png
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $DROP_UPLOAD_KEY" \
  -H "Content-Disposition: inline; filename=\"$(basename "$path")\"" \
  -H "Drop-Retention: 30d" \
  --data-binary "@$path" \
  https://drop.clay.sh/api/files
```

Use `/api/docs` for a Doc. Creation returns JSON containing `url`, `kind`, `contentType`, `size`, `retention`, `expiresAt`, and `etag`. Re-drops use `PUT`, the owning Upload Key, and `If-Match` with the last API ETag. Retention changes use `PATCH` with `{"retention":"30d"}` and the same authentication and ETag rules. Errors use `{"error":{"code":"...","message":"..."}}`.

## Security and operations

Upload Keys can create content and Re-drop only content created by that exact key. Admin Keys can list and delete Drops, manage Upload Keys, and run the expiry sweep, but cannot Re-drop content. Public reads require no credential. See [SECURITY.md](SECURITY.md) for the trust model and responsible disclosure process.

Drop stores content and metadata in Cloudflare R2 Standard storage. Operators pay for stored GB-months plus Class A writes and lists and Class B reads. Direct R2 egress has no data transfer charge under Cloudflare's current pricing. API writes and admin requests also consume Workers requests and CPU time. Check Cloudflare's current [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before operating a deployment.

Operational limits are intentionally plain:

- One production Worker and two R2 buckets. There is no SLA, database, queue, backup, replica, or recovery promise.
- A 95 MiB application upload limit, below Cloudflare's 100 MB request-body limit on Free and Pro plans.
- A 512 KiB Doc limit.
- One daily expiry sweep. Expiry is approximate.
- No application rate limiter, custom log sink, inventory search index, or content cache.
- Public URLs cannot retract copies made by browsers, chat clients, or other downstream systems.

### Provision production

From a clean checkout, provision Cloudflare and deploy the Worker:

```console
bun install --frozen-lockfile
bun run provision
```

The provisioning wizard asks for one temporary, scoped Cloudflare API token, shows the Terraform plan, and waits for confirmation before applying it. Terraform adopts the resources from earlier runs and owns the R2 buckets, public-access settings, Worker route and cron, cache bypass, response headers, and disabled Worker subdomains. Wrangler owns only the Worker code, bindings, observability configuration, and Admin Key.

Provisioning stops after it configures the initial Upload Key in the local CLI. It stores the Admin Key at `$XDG_CONFIG_HOME/drop/admin-key`, or `~/.config/drop/admin-key` when `XDG_CONFIG_HOME` is unset, with mode `0600`.

Run live acceptance separately:

```console
bun run verify:production
```

The verification wizard reads the local Admin and Upload Keys, creates a bucket-scoped two-hour R2 credential, and revokes that credential automatically, including after a failed run. It changes only temporary test Drops and credentials. It does not run Terraform, deploy Worker code, or change the daily cron. It pauses for the browser refresh check, final log inspection, and revocation of the temporary Cloudflare token.

The Terraform root is in [`infra/terraform`](infra/terraform/README.md). Its state files and saved plans are intentionally local and ignored; committed import blocks adopt the production resources from a fresh checkout.

`bun run bootstrap` remains an alias for `bun run provision`.

## Develop

Install [Bun](https://bun.sh/), then run:

```console
bun install --frozen-lockfile
bun run typecheck
bun test
```

Worker integration tests start Wrangler in local mode and never use production resources. Release startup tests compile and execute a standalone binary. The repository is licensed under MIT.
