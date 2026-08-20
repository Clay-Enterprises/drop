# Use R2 for control state

Drop stores public Files and Docs in `drop-content` and exact Upload Key records in a separate private `drop-control` R2 bucket. A single registry object was rejected because it would require contended read-modify-write updates, and Workers KV was rejected because newly created and revoked credentials require strong consistency.
