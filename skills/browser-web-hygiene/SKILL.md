---
name: browser-web-hygiene
description: React-agnostic web safety checklist for any code that renders in a browser. Covers XSS, untrusted URL handling, external links, browser storage, CSRF on mutating requests, postMessage, clickjacking, open redirects, and error-message leakage. Applies equally to React, Vue, Svelte, or plain HTML apps.
axis: domain
---

# Browser Web Hygiene

A review and authoring checklist for code that runs in a browser. Nothing here is framework-specific. If the same rule applies in Svelte or in a static HTML page, it belongs in this skill; if a rule exists only because of React's reconciler or hook rules, it belongs in `react-component-discipline` instead.

## Untrusted Content In Markup

Escape all interpolated values by default. The renderer you are using should escape string children — rely on it. Never reach for an escape hatch to render a string that originated from a user, an external API, a database, or a file.

- Ban `dangerouslySetInnerHTML` (React), `innerHTML =` assignments, `outerHTML =`, `document.write`, and `insertAdjacentHTML`. If you see one of these touching untrusted content, that is BLOCKING.
- If raw HTML is genuinely required (rendering a markdown preview, an email body, etc.), sanitize at the source with a vetted library (e.g. DOMPurify) and pin the sanitizer configuration — do not trust a default.
- Attribute interpolation is escaping too: be wary of SVG `xlink:href`, CSS `url(...)` inside inline `style`, and any attribute that accepts a URL (see below).

## URL And Href Validation

Reject dangerous URL schemes before assigning any user-controlled string to an attribute that the browser will navigate or fetch.

- Blocklist: `javascript:`, `data:`, `vbscript:`, `file:`. Allowlist beats blocklist when feasible — prefer constraining URLs to `https:` and same-origin relative paths.
- Attributes that need validation: `href`, `src`, `action`, `formaction`, `background`, `ping`, `srcset`, CSS `url(...)`.
- Never pass user input to `location.assign`, `location.replace`, `location.href =`, `window.open`, or router `navigate()` without allowlist validation.

## External Links

Every `<a target="_blank">` must pair with `rel="noopener noreferrer"`. Without `noopener`, the opened page can access `window.opener` and navigate the parent tab (reverse tabnabbing). Without `noreferrer`, the referrer header leaks the current URL, which may contain tokens or private identifiers.

## Browser Storage Hygiene

`localStorage` and `sessionStorage` are synchronous, same-origin, plaintext, and readable by any script running on the page. Treat them as a public bulletin board.

- No secrets, no auth tokens, no PII in `localStorage` or `sessionStorage`. Auth material belongs in httpOnly cookies set by the server.
- Scope storage keys with a tenant or project discriminator so cross-tenant data cannot leak when a user switches contexts.
- Clear storage on logout. Do not rely on the tab closing to clean up.

## CSRF On Mutating Requests

Mutating endpoints (anything that changes server state) must require explicit application headers — not just cookies. The coordination server expects `X-Project-Id` and `X-Agent-Name` headers; browser callers must send them deliberately, which a cross-origin attacker cannot forge from a cookie-only request.

Never rely on implicit cookie-based auth for a mutation. Never use `GET` for a mutation. Validate Content-Type on JSON endpoints.

## postMessage

`window.postMessage` ignores origin by default. If you accept messages:

- Always validate `event.origin` against a hard-coded allowlist. Reject anything else.
- Never trust `event.source` as an identity claim.
- Never evaluate or render an incoming payload without treating it as untrusted input.

Sending side: always pass an explicit target origin, never `"*"`, when the message contains anything remotely sensitive.

## Clickjacking

Do not embed untrusted third-party iframes without `sandbox` and a minimal allow-list. Do not render your own app inside an iframe unless the server sets `X-Frame-Options: DENY` or an appropriate CSP `frame-ancestors` directive. If an iframe must be embedded, restrict its privileges with `sandbox` and only open the flags it needs.

## Open Redirects

If a route or handler accepts a `redirect`, `next`, `returnTo`, or `continue` query param, validate it against an allowlist of same-origin paths before navigating. An attacker who can get your app to redirect to an arbitrary URL has a phishing primitive — your domain lends trust to the destination.

## Information Leakage In Error Messages

Errors shown to a user must not contain stack traces, raw SQL or query fragments, internal file paths, environment variable values, or server hostnames. Map backend errors to a minimal user-facing shape at the boundary. Log the full detail server-side, not in the DOM.

## Review Checklist

1. No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, or `document.write` touches untrusted input.
2. Every user-controlled URL is validated against an allowlist before flowing into an href/src/action attribute or a navigation call.
3. Every `target="_blank"` has `rel="noopener noreferrer"`.
4. No secrets or PII in `localStorage`/`sessionStorage`; storage keys are tenant-scoped; logout clears storage.
5. Mutating requests require explicit application headers; no cookie-only mutations.
6. Every `postMessage` receiver validates `event.origin`; every sender passes a concrete target origin.
7. No untrusted iframe without `sandbox`; the app itself is protected against being framed.
8. No route accepts a redirect URL without same-origin allowlist validation.
9. No error shown to the user contains stack traces, SQL, or internal paths.
