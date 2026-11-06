# Satoshi

Self-hosted so the page makes no third-party font request at runtime.

- Family: **Satoshi** by Indian Type Foundry
- Weights: 400, 500, 700 (`.woff2`, static)
- Licence: free for personal and commercial use under the
  [Fontshare licence](https://www.fontshare.com/licenses/itf-ffl)
- Source: <https://www.fontshare.com/fonts/satoshi>

The files are unmodified downloads from Fontshare's CDN. `styles.css` declares
three `@font-face` rules and `index.html` preloads those three, so the first
paint does not wait on a stylesheet parse to discover them; there is no network
fallback and no Google Fonts request.
