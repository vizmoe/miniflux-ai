# Third-party notices

The compatibility tables and sanitizer behavior in `src/html/minifluxSanitizer.ts` are adapted from [Miniflux 2.2.17](https://github.com/miniflux/v2/blob/2.2.17/internal/reader/sanitizer/sanitizer.go).

Copyright The Miniflux Authors. All rights reserved. Licensed under the [Apache License, Version 2.0](licenses/Miniflux-Apache-2.0.txt).

This repository implements that behavior in TypeScript with HTML5 tree construction and tests against the [supported Miniflux release](docs/miniflux.md#versions). It does not include the upstream Go implementation. Installed packages retain their own licenses in `node_modules`; their exact versions and integrity hashes are recorded in `pnpm-lock.yaml`.

The project's own code is licensed under [MIT](LICENSE). The third-party material
identified above retains its original license and attribution.
