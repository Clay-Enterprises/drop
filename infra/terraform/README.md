# Production infrastructure

This Terraform root manages the steady-state Cloudflare infrastructure for `drop.clay.sh`:

- the private `drop-control` and public-origin `drop-content` R2 buckets;
- empty CORS policies and disabled `r2.dev` access;
- the `/api/*` Worker route and daily expiry cron;
- disabled Worker and preview subdomains;
- cache bypass and security response headers for public Files and Docs.

The existing `drop-content` custom domain is read and asserted instead of managed. Cloudflare's provider cannot import an existing R2 custom-domain resource. Small idempotent helpers delete CORS, keep `drop-control` free of custom domains, and register the account-level `workers.dev` name because Cloudflare rejects an empty CORS resource and the other absent/account-level states are not represented by the provider.

Run `bun run bootstrap` from the repository root for the complete, guarded workflow. It supplies the token through `CLOUDFLARE_API_TOKEN`, saves a plan for review, and asks before applying it. Do not put tokens in `.tfvars` files or command-line arguments.

Terraform state and plans are local and ignored. The import blocks adopt resources created before Terraform took ownership, so a fresh checkout converges without deleting or recreating them. Wrangler deliberately does not declare routes or schedules; it owns Worker code and bindings while Terraform owns the triggers.
