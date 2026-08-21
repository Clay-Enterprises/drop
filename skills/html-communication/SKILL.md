---
name: html-communication
description: Create or revise a self-contained HTML communication Doc and publish it through Drop when the user wants a shareable visual document.
---

# HTML communication

## When to use

Use this skill when the user wants a plan, spec, write-up, findings, summary, report, comparison, or set of UI mocks presented as readable HTML.

Do not use it for HTML that ships as part of a product.

## Document

Create a self-contained HTML file capped at 512 KiB (524,288 bytes).

- Write it like a spec, not a landing page. Keep it dense and scannable, without a hero, decorative chrome, marketing voice, or em dashes.
- Default to true black (`#000`), white primary text, and dark gray only for secondary areas or accents.
- Make it mobile-readable with a responsive viewport and no fixed-width layout.
- Use semantic HTML, inline CSS, inline SVG, and data or HTTPS media.
- Use an inline classic script only when interactivity materially helps. Keep scripted Docs useful without JavaScript.
- In script-free files, give external links `target="_blank"` and `rel="noopener noreferrer"`. If any script exists, omit `target="_blank"`.

Never include external or module scripts, inline event handlers, `javascript:` URLs, forms, frames, embeds, objects, applets, meta refresh, linked stylesheets, storage APIs, script-initiated network requests, workers, script-created popups, secrets, private network URLs, or local file system paths.

## UI mocks

When the user asks for variants:

- Render real styled variants instead of descriptions.
- Label them `A`, `B`, `C`, and so on for easy selection.
- Lay them out for direct comparison.
- Keep one file across iterations so its path stays stable.

## Publish and revise

Write the Doc to a durable local `.html` path before publishing. If revising a Doc, overwrite the same local path. The path is its Local Path Identity.

Run `command -v drop`. If it fails, keep the local artifact and report exactly what is needed: install the Drop CLI and make sure `drop` is on `PATH`.

Run `drop <path>`, quoting the real path for the active shell. If the CLI reports that no Upload Key is configured, keep the local artifact and report the exact setup choices: run `drop auth set` or set `DROP_UPLOAD_KEY`. For any other publishing failure, keep the local artifact and report the CLI error.

Return the Unlisted URL printed by a successful `drop` invocation. Never claim the Doc is hosted before that command succeeds. Running the skill again for the same local path Re-drops the Doc at its existing live URL. Tell the user to perform a manual browser refresh to see the revision. Expiry or explicit deletion is terminal and causes the next drop to receive a new URL.

Do not open or verify the Doc in a browser unless the user asks.
