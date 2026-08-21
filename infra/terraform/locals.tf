locals {
  account_id = "6e0cccdd787599d868ec17156c8d372f"
  zone_id    = "cd34ef6f8b96c248bb885c7e47f82152"

  public_origin = "https://drop.clay.sh"
  worker_name   = "drop"

  public_path_expression = "(http.host eq \"drop.clay.sh\" and (starts_with(http.request.uri.path, \"/files/\") or starts_with(http.request.uri.path, \"/docs/\")))"
  doc_path_expression    = "(http.host eq \"drop.clay.sh\" and starts_with(http.request.uri.path, \"/docs/\"))"

  doc_csp = "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src data: https:; media-src data: https:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"
}
