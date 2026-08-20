# Use metadata-driven expiry for stable URLs

Drop stores retention metadata with suffixless R2 objects and deletes expired objects with a daily scheduled sweep. Native R2 lifecycle rules were rejected because retention must remain mutable without changing a public URL, while lifecycle rules select objects by key prefix, mutate shared bucket configuration, and are limited to 1,000 rules.
