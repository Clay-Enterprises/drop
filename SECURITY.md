# Security

## Supported versions

Security fixes target the latest published release and `main`. Older standalone binaries are not supported.

## Security model

Every File and Doc has a public unlisted URL containing a random Opaque ID. The URL is suitable for proprietary material, but not secrets. Anyone who receives it can read and copy the content. Drop has no reader authentication, URL revocation, downstream cache control, backup, recovery promise, or SLA.

An Upload Key authorizes creation and Re-drops for content created by that exact key. Replacing or revoking a key does not transfer ownership. An Admin Key can inspect inventory, delete Drops, and manage Upload Keys. It cannot Re-drop content. Keep both credentials out of source control, shell history, logs, Docs, and Files.

The CLI stores the Upload Key in the XDG configuration directory and uses mode `0600` where the operating system supports POSIX permissions. Local path bindings contain URLs and ETags, but no credential material. Public reads go directly to R2. API and admin requests pass through the Worker.

Expiry and administrator deletion stop future reads from Drop, but cannot retract copies made before deletion. There is no inventory operation available to Upload Keys.

## Responsible disclosure

Do not open a public issue for a suspected vulnerability. Report it through a private [GitHub security advisory](https://github.com/Clay-Enterprises/drop/security/advisories/new) with reproduction steps, affected versions, and impact. Please avoid accessing content you do not own, disrupting the service, or publishing details before a fix is available.

We will acknowledge a responsible disclosure, investigate it, and coordinate release timing with the reporter. This project does not offer a bug bounty.
