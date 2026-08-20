# Serve public content directly from R2

Drop routes `/api/*` through a Worker while `/files/*` and `/docs/*` are served directly from the public `drop-content` R2 bucket with caching disabled. This keeps public reads and media egress out of the application while preserving authenticated uploads, administrative operations, and document-specific response headers at the Cloudflare boundary.
