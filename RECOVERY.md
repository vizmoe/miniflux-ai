# Source provenance

This development project was recovered from the JavaScript shipped in `registry.viz.moe/minfilux-ai:latest` and an original-source snapshot retained by SonarQube. The original image name contains the spelling `minfilux`; the recovered project consistently uses `miniflux-ai`.

The extraction used the Linux ARM64 image with image ID `sha256:6c41dcce5e841aa16cbb11e7addf9f6419825e150c0c9131d5e467407c49a5de` and image digest `sha256:6e6ae7e7e34f0724e741804502bc4351bee9ee4a47ece326c11d214cd25fcd9d`. Its source labels identify `https://github.com/vizmoe/miniflux-ai` and revision `5502766e5b0de456d89e6041dfd0027362c33330`. These labels are provenance, not proof that this reconstruction is identical to that checkout.

The image contained no project TypeScript and no embedded source text in its 59 source maps. The initial reconstruction inferred types from validation schemas, database schemas and call contracts, expanded the bundled console into typed browser source in `web/`, and recreated build scripts, tests, CI workflows and operating documentation.

SonarQube project `miniflux-ai`, branch `main`, retained analysis `13668605-85d7-46d6-8893-58b473ed6e14` from 2026-10-12. Its reported revision matches the image revision above. Read-only extraction recovered 111 scanned files, including all 59 original server TypeScript modules, modular console sources and original tests. Each recovered file matched SonarQube's stored source hash; the independent reference snapshot also records SHA-256 checksums. This establishes the scanned source text, not a complete original Git checkout. Unscanned manifests, lockfiles, most configuration, Markdown documentation and Git history remain unavailable.

The server source in `src/` now restores original type declarations, comments and access restrictions while retaining the maintained formatting protocol, artifact compatibility, validation, error handling and admission recovery. The upgraded dependencies, toolchain and delivery configuration remain authoritative. The console currently uses the reconstructed `web/` source; the complete scanned snapshot is preserved separately from the maintained project.

The SQL migrations and migration metadata are preserved byte for byte. Their original hashes are retained in [the migration compatibility fixture](tests/fixtures/migrations.json) and checked by the database tests. Existing databases still need a normal backup before upgrade; schema compatibility alone does not prove every possible production state has been exercised.

Builds now emit source maps with embedded TypeScript for both the server and browser. Keep the Git repository and lockfile as the development source of truth; a runtime image is not a replacement for repository backups.

The original MIT license, third-party notices and bundled license files remain included.
