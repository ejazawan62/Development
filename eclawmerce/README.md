# eClawmerce website

Static storefront for eClawmerce. Plain HTML, CSS and JavaScript, no build step. Open `index.html` in a browser to preview.

| Path | What it is |
| --- | --- |
| `index.html` | The page: hero, categories, products, why us, newsletter, footer |
| `css/style.css` | All styles, including dark mode and mobile layout |
| `js/main.js` | Products, categories, search, sort, cart and WhatsApp checkout |
| `assets/logo.svg` | Full logo (mark + wordmark) |
| `assets/logo-mark.svg`, `assets/favicon.svg` | Icon-only logo |

## Sample content to replace before going live

- **Products, prices, categories**: `PRODUCTS` and `CATEGORIES` in `js/main.js`.
- **WhatsApp number**: `WHATSAPP` in `js/main.js` and `0300 000 0000` / `923000000000` in `index.html`.
- **Email**: `support@eclawmerce.com` in `index.html`.
- **Promises**: free delivery threshold, delivery times, 7-day returns, payment methods.
- **Logo and colours**: if you have an official logo, replace the files in `assets/`; brand colours are `--brand` and `--brand-2` at the top of `css/style.css`.

Checkout needs no server: the cart builds a WhatsApp message with the order, which the customer sends to your number.
