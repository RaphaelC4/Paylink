# Vendored dependency

`near-connect.js` is the CommonJS build of
[`@hot-labs/near-connect`](https://github.com/azbang/near-connect) (HOT Labs),
minified and vendored so the app needs no bundler, no npm install and no CDN at
runtime. The module namespace is exposed as the default export, which is why
`app.js` destructures `NearConnector` from it.

Licence: MIT, as published by the upstream package. This file is unmodified
apart from the build step that produced it. To update, take the package's
CommonJS bundle and replace this file, then bump the `?v=` on `app.js` in
`index.html`.

The connector fetches the wallet-selector manifest from
`raw.githubusercontent.com/hot-dao/near-selector` at runtime. That is the
wallet's own registry; no application data is sent.
