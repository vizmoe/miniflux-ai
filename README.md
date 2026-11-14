# miniflux-ai

A companion service for one Miniflux account. It translates articles, generates summaries, and imports scheduled digests back into Miniflux while preserving the original article content. A browser console manages AI providers, processing rules, entries and tasks.

This repository was recovered from a container image and a matching SonarQube source snapshot. See [RECOVERY.md](RECOVERY.md) for provenance and the limits of the recovery.

## Run with Docker Compose

1. Create the configuration directory and copy the example:

   ```sh
   mkdir -p config
   cp config.example.yaml config/config.yaml
   openssl rand -hex 32
   ```

2. Edit `config/config.yaml`. Set your Miniflux base URL and API key, and replace `server.admin_token` with the generated token. The configuration is YAML; environment-variable interpolation inside it is not supported. You can leave `ai.providers` empty and configure a provider through the console.

3. Give the container permission to read and atomically replace the configuration. The image runs as UID/GID `1000:1000`; the entire configuration directory must be writable by that user. For a Linux host:

   ```sh
   sudo chown -R 1000:1000 config
   sudo chmod 700 config
   sudo chmod 600 config/config.yaml
   ```

   Docker Desktop and OrbStack can map bind-mount ownership differently. If saving settings returns `configuration_unwritable`, check the directory's effective permissions from inside the container. Mount the directory rather than an individual config file: saving uses an atomic file replacement.

4. Build and start:

   ```sh
   docker compose up --build -d
   docker compose logs -f miniflux-ai
   ```

5. Open <http://localhost:8080/console/> and sign in with the admin token. Under **Models**, enter a provider ID, a Chat Completions API base URL, an API key and a model ID. A base URL normally ends in `/v1`; do not append `/chat/completions`.

The example starts in provider setup mode. `/healthz` succeeds when the HTTP server is running; `/readyz` remains unavailable until the model, Miniflux account binding and ingestion bootstrap are ready. Saving a provider does not make a test model call.

The recovered service checks Miniflux against the version declared in [the runtime constants](src/config/constants.ts). Use that compatible Miniflux release or validate a deliberate compatibility change before upgrading it. A failed compatibility probe pauses new ingestion and task claims; the service retries the probe and resumes work after recovery. The service supports Chat Completions providers with JSON output, including JSON and SSE transport responses; it does not implement the OpenAI Responses API.

For an image published by the included workflow:

```sh
export MINIFLUX_AI_IMAGE=ghcr.io/your-owner/miniflux-ai:0.1.0
docker compose pull
docker compose up -d --no-build
```

`MINIFLUX_AI_IMAGE`, `MINIFLUX_AI_BIND` and `MINIFLUX_AI_PORT` configure Compose, not application settings. The Compose file binds to host loopback by default. For remote use, route the service through your HTTPS reverse proxy and set `server.admin_origin` to its public origin, for example `https://ai.example.com`. This also selects secure session cookies and the expected origin for browser writes.

## Configure processing

The complete configuration contract and defaults are defined in [the configuration schema](src/config/index.ts), with [scope predicates](src/config/scope.ts) and [prompt templates](src/config/prompts.ts) alongside it. Unknown keys and duplicate YAML keys are rejected.

- **Translation** writes translated blocks and a translated title alongside the retained source. It preserves Miniflux-supported inline formatting, explicit line breaks, links, and inline code. Responses that lose formatting are repaired or rejected before saving. `output_language` supplies the shared output language; `features.translation.target_language` can override it. Existing translations remain readable; reprocess their translation feature to regenerate them with formatting.
- **Summary** supports paragraph or bullet output, a minimum source size, an output-size limit, and an optional schedule.
- **Processing rules** in the console select all feeds or selected feeds and manage allowlists and blocklists. YAML can additionally express content and language predicates. Rules are ordered; the first matching rule determines the outcome.
- **Models** supports multiple providers. Higher priority is tried first; list order breaks ties. Failures can put providers into cooldown. A blank API key on an existing, unchanged provider endpoint retains its saved key.

Provider and scope edits are persisted to YAML and apply to subsequent work. Already queued work retains its captured execution settings where the task contract requires it. Changes to other configuration fields require a restart; the console reports that condition.

HTTPS is required for upstream URLs unless `runtime.allow_insecure_http` is explicitly enabled. This switch is useful for Miniflux on a private Docker network. Application credentials are read from the YAML file and redacted from the management views.

### Webhooks and polling

Polling is always available. On the first startup, the cursor is initialized to the latest existing Miniflux entry, so historical articles are not automatically processed. Use backfill for existing entries.

To enable webhooks, add a shared secret:

```yaml
ingestion:
  webhook:
    enabled: true
    secret: replace-with-a-separate-random-secret
```

Configure Miniflux to deliver new-entry events to `/webhook/miniflux` with the same secret. The service verifies `X-Miniflux-Signature` as the hexadecimal HMAC-SHA256 of the raw request body and expects `X-Miniflux-Event-Type: new_entries`. The request must carry the full entry metadata emitted by Miniflux, not only entry IDs. Polling continues to cover missed deliveries.

### Backfill and management API

The console uses an HTTP-only session cookie with same-origin checks for writes. Scripts can use `Authorization: Bearer <admin-token>` for `/admin/*` endpoints.

Preview a historical batch before admitting it:

```sh
export MINIFLUX_AI_URL=http://localhost:8080
export ADMIN_TOKEN='your-admin-token'
curl --fail-with-body "$MINIFLUX_AI_URL/admin/backfill" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"features":["translation","summary"],"limit":100,"dry_run":true}'
```

Read `/admin/backfill/<task-id>` for progress. Repeat with `dry_run: false` to admit selected entries. Optional filters include `since`, `until`, `feed_ids` and `category_ids`; use complete ISO timestamps. A dry run may use AI for language review, but it does not admit entries or write generated content to Miniflux.

Other operations include `GET /admin/entries`, `GET /admin/tasks`, `POST /admin/tasks/<id>/requeue`, `POST /admin/entries/<id>/reprocess?features=translation,summary`, `POST /admin/summaries/run`, and `POST /admin/recovery/run`. See [the server routes](src/server/index.ts) for exact request schemas and response codes. Reprocessing can make new model calls and change rendered content.

### Daily digests

Add a job under `features.digest`:

```yaml
features:
  digest:
    public_base_url: https://ai.example.com
    jobs:
      - id: daily
        cron: '0 8 * * *'
        lookback: 24h
        min_item_source_units: 200
        output:
          feed_title_template: AI daily digest
          destination_category_id: 1
```

Schedules use UTC and digest schedules select one time per matching day. Choose a real destination category from your Miniflux account. The public base URL must be reachable by Miniflux. The service provisions an Atom feed at `/digest/feeds/daily.xml` and imports generated digest entries directly through the Miniflux entry-import API. It exposes digest permalink pages under `/digest/daily/<date>`. These feed and permalink routes are public.

To reuse an existing feed, set `output.existing_feed_id`; its feed URL must match the service's expected URL. Category partitioning is also supported through `output.partition_by: category` and category-aware templates; see the schema for the required placeholders. A manual run uses `POST /admin/digests/run` with `{"job_id":"daily"}` and an optional `window_end`.

## Data and operations

The persistent state is `/app/data` in the image and `./data` when running locally. The database and lock filenames are defined in [the runtime constants](src/config/constants.ts). SQLite migrations run automatically before the service starts.

Run one service instance per data directory and Miniflux account. An OS file lock prevents concurrent writers. The database records account identity; changing the configured account or base URL is checked before work resumes. The management interface provides the base-URL confirmation operation for an intentional move of the same account.

Back up both the configuration directory and the entire data volume. For a straightforward filesystem backup, stop the service first and preserve the database together with any WAL/SHM files. Keep a backup before an upgrade; do not edit applied migration files. Translation artifacts now store formatting information that older binaries cannot read. To roll back, use the earlier image and a compatible pre-upgrade data backup.

`GET /healthz` is the liveness check used by Docker, `GET /readyz` reports processing readiness, and `/metrics` serves Prometheus metrics. Logs are structured JSON. Metrics are not protected by the admin token; restrict their exposure in your proxy when needed.

## Develop and verify

Use Linux or macOS. Native dependencies include SQLite bindings and `flock`; native Windows execution is not supported, so use WSL2 or Docker on Windows. Building native dependencies requires Python and a C/C++ toolchain; install Xcode Command Line Tools on macOS or the corresponding build packages on Linux.

The toolchain is pinned in [mise.toml](mise.toml), [.node-version](.node-version) and [package.json](package.json). With mise:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
cp config.example.yaml config.yaml
# Edit config.yaml with your connection details and admin token.
mise exec -- pnpm dev
```

Run from the project directory so local state is stored under its ignored `data/` directory. Pass `--config /absolute/path/config.yaml` to select another configuration. After a build, start the compiled application with `mise exec -- pnpm start --config ./config.yaml`.

```sh
mise exec -- pnpm check
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm test:admin
mise exec -- pnpm docker:build
mise exec -- pnpm docker:test
```

The scripts in [package.json](package.json) are the authoritative check and build entry points. `pnpm check` includes strict typing, lint, formatting, unit/database coverage, a clean build and HTTP integration tests. The browser test requires Playwright Chromium. The container test accepts another image name, for example `pnpm docker:test miniflux-ai:recovered`.

Tests use isolated temporary SQLite databases and controlled local Miniflux/AI HTTP fixtures. They do not prove compatibility with a live provider account or a running upstream Miniflux deployment. The container smoke test runs without an external network and checks non-root startup, health, browser assets, authentication, embedded source maps, clean shutdown and data persistence across restart. Coverage, browser screenshots and Playwright traces are generated into ignored artifact directories.

Server code lives in `src/`, browser source in `web/`, migrations in `drizzle/`, and tests in `tests/`. `pnpm build` recreates `dist/`, including browser assets, declaration files and source maps with embedded source text. Use `pnpm db:generate` after an intentional schema change and review the generated migration before applying it.

## CI and image publishing

[CI](.github/workflows/ci.yml) verifies Linux and macOS builds, runs the browser flow on Linux, retains verification artifacts, and builds and smoke-tests the Linux container. It runs for pull requests and pushes to `main`, and can also be invoked manually or by the publication workflow.

[Publish image](.github/workflows/release.yml) runs verification before publishing a multi-platform image for `linux/amd64` and `linux/arm64`. It runs on version tags such as `v0.1.0`, or through a manual workflow dispatch with an image tag. Stable releases publish version, `major.minor`, commit and `latest` tags; prereleases do not move `latest`. Published images include build provenance and an SBOM. Actions are pinned to immutable revisions.

By default, images go to `ghcr.io/<owner>/<repository>` using the workflow's `GITHUB_TOKEN` with package-write permission. To use another registry, configure these GitHub repository settings:

| Setting             | Kind     | Example / purpose                                   |
| ------------------- | -------- | --------------------------------------------------- |
| `IMAGE_REGISTRY`    | Variable | `registry.viz.moe`                                  |
| `IMAGE_NAME`        | Variable | `miniflux-ai` or a registry-specific namespace/path |
| `REGISTRY_USERNAME` | Secret   | Account allowed to push this image                  |
| `REGISTRY_PASSWORD` | Secret   | Registry password or push token                     |

No runtime Miniflux or AI keys are needed by CI. Configure registry access and package visibility in the destination repository before publishing. Creating and pushing a release tag will publish an image; local development and `docker:build` only create local images. Deployment remains an explicit operator action using Compose or your deployment system; no production host or deployment credentials are assumed by these workflows.

## License

[MIT](LICENSE). Runtime dependency notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [licenses/](licenses/).
