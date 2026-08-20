# Drop

Drop is a small publishing service for sharing uploaded media and self-contained HTML documents through public, unlisted URLs.

## Language

**Drop**:
The service at `drop.clay.sh`. As a verb, "drop" means uploading a File or Doc to the service.
_Avoid_: Drop file, object store

**File**:
An uploaded non-HTML artifact. A File is one of Drop's two content categories, regardless of its media type. A Re-drop may change a File from one accepted media type to another without changing its identity.
_Avoid_: Asset, blob, object

**Doc**:
A self-contained HTML communication document. A Doc is distinct from a File because the browser renders it as a document at its public URL.
_Avoid_: HTML file, page, site

**Unlisted URL**:
A public address containing an opaque identifier that cannot feasibly be guessed. Anyone with the URL can read its File or Doc, so it is suitable for proprietary material but not secrets.
_Avoid_: Private URL, secret URL, signed URL

**Opaque ID**:
The non-meaningful identifier in an Unlisted URL. It reveals neither the original filename nor information that can be used to discover another File or Doc.
_Avoid_: Filename, slug, sequential ID

**Re-drop**:
Publishing new content for an existing File or Doc while preserving its Unlisted URL. A Re-drop resets the File or Doc's retention period and may change its Retention Class. An expired or explicitly deleted Drop cannot be revived; dropping that Local Path Identity again creates a new Drop.
_Avoid_: Re-upload, new Drop

**Local Path Identity**:
The normalized absolute path the CLI uses to recognize a Re-drop. Copying or moving content to another path gives it a new identity and therefore creates a new Drop.
_Avoid_: Filename, content hash

**Retention Class**:
The mutable lifetime assigned to a File or Doc. The available classes are 7 days, 30 days, 90 days, and indefinite retention. Changing it preserves the Unlisted URL.
_Avoid_: Expiry date, TTL

**Expiry**:
The automatic, terminal deletion of a File or Doc at the end of its Retention Class. Dropping the same Local Path Identity after Expiry creates a new Drop with a new Unlisted URL.
_Avoid_: Archive, deactivation

**Upload Key**:
An independently revocable credential that grants permission to create Files and Docs and Re-drop those it created. Authorization belongs to the exact credential, not a rotatable identity. Replacing a key means creating a distinct key and revoking the old one. A different Upload Key cannot replace its Drops. It grants no inventory or deletion access.
_Avoid_: API key, user account, login

**Admin Key**:
The operator credential that grants permission to inspect inventory and delete Files and Docs.
_Avoid_: Upload key, Cloudflare credential
