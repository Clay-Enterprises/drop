resource "cloudflare_r2_bucket" "control" {
  account_id    = local.account_id
  name          = "drop-control"
  jurisdiction  = "default"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "content" {
  account_id    = local.account_id
  name          = "drop-content"
  jurisdiction  = "default"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_cors" "control" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.control.name
  rules       = []
}

resource "cloudflare_r2_bucket_cors" "content" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.content.name
  rules       = []
}

resource "cloudflare_r2_managed_domain" "control" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.control.name
  enabled     = false
}

resource "cloudflare_r2_managed_domain" "content" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.content.name
  enabled     = false
}

# Absence is not a first-class provider resource. Run this idempotent helper
# when a fresh state adopts production so drop-control cannot have an R2
# custom domain left over from earlier configuration.
resource "terraform_data" "control_custom_domains" {
  triggers_replace = [
    filesha256("${path.module}/../../scripts/ensure-control-bucket-private.ts"),
  ]

  provisioner "local-exec" {
    command = "bun run ../../scripts/ensure-control-bucket-private.ts"

    environment = {
      CLOUDFLARE_ACCOUNT_ID = local.account_id
    }
  }

  depends_on = [cloudflare_r2_bucket.control]
}

# The provider cannot import an existing R2 custom domain. Keep the live domain
# where it is and fail the plan if its ownership, TLS, or bucket changes.
data "cloudflare_r2_custom_domain" "content" {
  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.content.name
  domain      = "drop.clay.sh"
}

resource "terraform_data" "content_domain_guard" {
  input = data.cloudflare_r2_custom_domain.content.domain

  lifecycle {
    precondition {
      condition = (
        data.cloudflare_r2_custom_domain.content.enabled &&
        data.cloudflare_r2_custom_domain.content.min_tls == "1.2" &&
        data.cloudflare_r2_custom_domain.content.zone_id == local.zone_id &&
        data.cloudflare_r2_custom_domain.content.status.ownership == "active" &&
        data.cloudflare_r2_custom_domain.content.status.ssl == "active"
      )
      error_message = "drop.clay.sh must be an active drop-content custom domain with active TLS 1.2 in the clay.sh zone."
    }
  }
}

# Cloudflare requires this account-level name before it accepts cron triggers.
# The provider only exposes the per-Worker subdomain setting, so a small
# idempotent helper covers this one API gap.
resource "terraform_data" "workers_account_subdomain" {
  triggers_replace = [
    filesha256("${path.module}/../../scripts/ensure-workers-subdomain.ts"),
  ]

  provisioner "local-exec" {
    command = "bun run ../../scripts/ensure-workers-subdomain.ts"

    environment = {
      CLOUDFLARE_ACCOUNT_ID = local.account_id
      WORKERS_SUBDOMAIN     = "personal-domains-6e0"
    }
  }
}

resource "cloudflare_workers_route" "api" {
  zone_id = local.zone_id
  pattern = "drop.clay.sh/api/*"
  script  = local.worker_name
}

resource "cloudflare_workers_cron_trigger" "expiry" {
  account_id  = local.account_id
  script_name = local.worker_name
  schedules = [
    { cron = "0 0 * * *" },
  ]

  depends_on = [terraform_data.workers_account_subdomain]
}

resource "cloudflare_workers_script_subdomain" "drop" {
  account_id       = local.account_id
  script_name      = local.worker_name
  enabled          = false
  previews_enabled = false

  depends_on = [terraform_data.workers_account_subdomain]
}

resource "cloudflare_ruleset" "public_cache" {
  zone_id     = local.zone_id
  name        = "Drop public cache policy"
  description = "Do not cache public Drop files or docs"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [{
    action      = "set_cache_settings"
    description = "Drop public reads do not cache"
    enabled     = true
    expression  = local.public_path_expression
    ref         = "drop_public_reads_do_not_cache"
    action_parameters = {
      cache = false
    }
  }]
}

resource "cloudflare_ruleset" "public_headers" {
  zone_id     = local.zone_id
  name        = "Drop public response headers"
  description = "Security and cache response headers for public Drop content"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [
    {
      action      = "rewrite"
      description = "Drop public response headers"
      enabled     = true
      expression  = local.public_path_expression
      ref         = "drop_public_response_headers"
      action_parameters = {
        headers = {
          "cache-control" = {
            operation = "set"
            value     = "no-store"
          }
          "referrer-policy" = {
            operation = "set"
            value     = "no-referrer"
          }
          "x-content-type-options" = {
            operation = "set"
            value     = "nosniff"
          }
          "x-robots-tag" = {
            operation = "set"
            value     = "noindex, nofollow, noarchive"
          }
        }
      }
    },
    {
      action      = "rewrite"
      description = "Drop Doc CSP"
      enabled     = true
      expression  = local.doc_path_expression
      ref         = "drop_doc_csp"
      action_parameters = {
        headers = {
          "content-security-policy" = {
            operation = "set"
            value     = local.doc_csp
          }
        }
      }
    },
  ]
}
