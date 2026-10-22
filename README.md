# DPIS website

Static website for DPIS, an internet service provider in Pakistan. Plain HTML, CSS and JavaScript, with no build step.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The website: packages, plan finder, coverage check, FAQ, contact form |
| `logos.html` | The four logo concepts side by side |
| `logos/` | Logo files (SVG). `dpis-signal-d.svg` is the logo used on the site |
| `css/style.css` | All styles, including dark mode |
| `js/main.js` | Plan finder, Home/Business tabs, coverage check, WhatsApp request form |

## Before going live, edit these

All of the following are **sample content**:

- **Prices and speeds**: the package cards in `index.html` and the `PLANS` list at the top of `js/main.js` (keep the two the same).
- **Phone / WhatsApp number**: search for `0300 000 0000` and `923000000000` (also `WHATSAPP` in `js/main.js`).
- **Email and office address**: `info@dpis.pk`, `Main Boulevard, Lahore`.
- **Cities and areas**: the `.cities` list in `index.html`. The coverage checker reads this list.
- **Promises** such as install time, support hours and free installation: change them to match what you really offer.

The contact form needs no server. It builds a WhatsApp message with the customer's details, which the customer then sends to your number.

## Preview locally

Open `index.html` in a browser, or run `python3 -m http.server` in this folder and visit http://localhost:8000.

## Hosting

Any static host works: GitHub Pages, Netlify, Cloudflare Pages, or normal cPanel hosting (upload all files to `public_html`).
