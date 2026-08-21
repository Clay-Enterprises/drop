# Adopt resources created by earlier bootstrap runs. Import blocks are safe on
# subsequent applies and make a fresh checkout converge on the same live state.
import {
  to = cloudflare_r2_bucket.control
  id = "${local.account_id}/drop-control/default"
}

import {
  to = cloudflare_r2_bucket.content
  id = "${local.account_id}/drop-content/default"
}

import {
  to = cloudflare_workers_route.api
  id = "${local.zone_id}/edeb31747973434982161f14e3bf33d4"
}

import {
  to = cloudflare_workers_cron_trigger.expiry
  id = "${local.account_id}/${local.worker_name}"
}

import {
  to = cloudflare_workers_script_subdomain.drop
  id = "${local.account_id}/${local.worker_name}"
}
