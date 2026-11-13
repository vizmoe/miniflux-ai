# Source provenance

This is a reconstructed development project for `miniflux-ai`. Its server TypeScript was recovered from the readable JavaScript shipped in `registry.viz.moe/minfilux-ai:latest`. The original image name contains the spelling `minfilux`; the recovered project consistently uses `miniflux-ai`.

The extraction used the Linux ARM64 image with image ID `sha256:6c41dcce5e841aa16cbb11e7addf9f6419825e150c0c9131d5e467407c49a5de` and image digest `sha256:6e6ae7e7e34f0724e741804502bc4351bee9ee4a47ece326c11d214cd25fcd9d`. Its source labels identify `https://github.com/vizmoe/miniflux-ai` and revision `5502766e5b0de456d89e6041dfd0027362c33330`. These labels are provenance, not proof that this reconstruction is identical to that checkout.

The image contained no project TypeScript and no embedded source text in its 59 source maps. Original comments, type annotations, private visibility, tests, build configuration and CI history cannot be recovered exactly. The code in `src/` retains the shipped module boundaries and application behavior; types have been reconstructed from validation schemas, database schemas and call contracts. The bundled console was expanded into typed browser source in `web/`. Build scripts, tests, CI workflows and operating documentation were recreated.

The SQL migrations and migration metadata are preserved byte for byte. Their original hashes are retained in [the migration compatibility fixture](tests/fixtures/migrations.json) and checked by the database tests. Existing databases still need a normal backup before upgrade; schema compatibility alone does not prove every possible production state has been exercised.

Builds now emit source maps with embedded TypeScript for both the server and browser. Keep the Git repository and lockfile as the development source of truth; a runtime image is not a replacement for repository backups.

The original MIT license, third-party notices and bundled license files remain included.
