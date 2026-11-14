import './style.css';
import type {
  Dashboard,
  Model,
  EntryList,
  Task,
  Status,
  Scopes,
  Subscriptions,
} from './types.js';
import { esc } from './html.js';
import { ScopeEditor } from './scopes.js';

const app = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#details')!;
const notice = document.querySelector<HTMLOutputElement>('#notice')!;
const skip = document.querySelector<HTMLAnchorElement>('.skip')!;
const num = (n: number) => n.toLocaleString('en-US');
const date = (v: string) =>
  new Date(v).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const icons: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  entries: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
  tasks: '<path d="m3 7 2 2 4-4M12 7h9M3 15l2 2 4-4M12 15h9"/>',
  model: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
  scopes:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  system: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  logout: '<path d="M10 4H4v16h6m4-13 5 5-5 5M9 12h11"/>',
};
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.entries}</svg>`;
const labels: Record<string, string> = {
  ready: 'Ready',
  pending: 'Pending',
  processing: 'Processing',
  scheduled: 'Scheduled',
  skipped: 'Skipped',
  failed: 'Failed',
  leased: 'Running',
  done: 'Done',
  dead: 'Failed',
  current: 'Written',
  never_requested: 'Not requested',
  generate_artifacts: 'Generate artifacts',
  render: 'Write to Miniflux',
  digest: 'Generate digest',
  ingest_backfill: 'Backfill entries',
  no_translatable_content: 'No translatable content',
  language_not_required: 'Language skipped',
  content_too_short: 'Content too short',
};
const label = (s: string | null) => (s ? (labels[s] ?? s) : 'Disabled');
function badgeStyle(s: string | null): string {
  if (['ready', 'current', 'done'].includes(s ?? '')) return 'success';
  if (['failed', 'dead'].includes(s ?? '')) return 'danger';
  if (['processing', 'leased', 'pending', 'scheduled'].includes(s ?? ''))
    return 'waiting';
  return 'muted';
}
const badge = (s: string | null) =>
  `<span class="badge ${badgeStyle(s)}">${esc(label(s))}</span>`;
const errors: Record<string, string> = {
  unauthorized: 'Session expired. Sign in again.',
  origin_rejected: 'This address is not allowed.',
  login_rate_limited: 'Too many attempts. Try again in 15 minutes.',
  invalid_request: 'Check the fields and allowed ranges.',
  api_key_required: 'Enter an API key for the new endpoint.',
  https_required: 'Use an HTTPS endpoint.',
  configuration_conflict: 'Configuration changed. Refresh before saving.',
  invalid_configuration: 'Check the configuration fields.',
  configuration_write_unavailable:
    'Unable to save. Check configuration directory permissions.',
  configuration_unavailable: 'Unable to read the configuration file.',
  configuration_alias_conflict:
    'Shared YAML values would change other settings. Separate them before saving.',
  scope_not_found: 'This scope is unavailable. Refresh the configuration.',
  feature_disabled: 'Enable this feature in the configuration first.',
  generation_in_progress: 'This entry is still processing. Try again later.',
  model_not_configured: 'Configure a model first.',
  source_projection_invalid:
    'Source structure changed. Check the entry in Miniflux.',
  entry_not_found: 'Entry not found.',
  service_unavailable: 'Service unavailable. Try again later.',
};
const loginErrors: Record<string, string> = {
  unauthorized: 'Invalid admin token.',
  origin_rejected: 'This address is not allowed.',
  login_rate_limited: 'Too many attempts. Try again in 15 minutes.',
  invalid_request: 'Enter your admin token.',
  service_unavailable: 'Service unavailable. Try again later.',
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(errors[code] ?? `Request failed: ${code}`);
  }
}
async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(60000),
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const problem = (await response
      .json()
      .catch(() => ({ code: 'service_unavailable' }))) as { code: string };
    if (response.status === 401 && path.startsWith('/admin/')) login();
    throw new HttpError(response.status, problem.code);
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
function flash(message: string, failure = false) {
  notice.textContent = message;
  notice.className = failure ? 'notice error' : 'notice';
}
function loginError(error: unknown): string {
  return (
    (error instanceof HttpError ? loginErrors[error.code] : undefined) ??
    'Unable to sign in. Try again.'
  );
}
function failed(error: unknown) {
  if (!authenticated) {
    flash(
      error instanceof HttpError && error.status === 401
        ? 'Session expired. Sign in again.'
        : loginError(error),
      true,
    );
    return;
  }
  flash(
    error instanceof Error ? error.message : 'Request failed. Try again.',
    true,
  );
}
function empty(message: string) {
  return `<div class="empty">${icon('entries')}<strong>${esc(message)}</strong></div>`;
}
const routes = [
  ['overview', 'Overview'],
  ['entries', 'Entries'],
  ['tasks', 'Tasks'],
  ['model', 'Models'],
  ['scopes', 'Processing rules'],
  ['system', 'System'],
] as const;
let authenticated = false,
  version = 0;
let model: Model | undefined;
let scopeEditor: ScopeEditor | undefined;
let entryCursor: number | null = null,
  taskCursor: number | null = null;
let entryFilter = { q: '', state: '', feature: 'translation', feed_id: '' },
  taskFilter = { state: '', type: '' };
const route = () => location.hash.slice(1).split('?')[0] || 'overview';

function login() {
  authenticated = false;
  scopeEditor = undefined;
  version++;
  dialog.close();
  notice.textContent = '';
  document.documentElement.lang = 'en';
  document.title = 'Sign in · miniflux-ai';
  skip.textContent = 'Skip to content';
  skip.href = '#login-content';
  app.innerHTML = `<main id="login-content" class="login-wrap" tabindex="-1"><section class="login-panel"><div class="wordmark"><span class="logo" aria-hidden="true">m<span>↗</span></span><span>miniflux<span class="light"> / ai</span></span></div><h1>Sign in</h1><form id="login-form"><label>Admin token<input name="token" type="password" required autocomplete="current-password" placeholder="Enter your token" aria-describedby="login-error" maxlength="4096" /></label><p class="form-error" role="alert" id="login-error"></p><button class="primary" type="submit">Sign in ${icon('arrow')}</button></form></section></main>`;
  app
    .querySelector<HTMLFormElement>('form')!
    .addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const button = form.querySelector('button')!;
      button.disabled = true;
      const token = new FormData(form).get('token');
      void api('/auth/session', 'POST', { token })
        .then(() => {
          form.reset();
          authenticated = true;
          shell();
          return render();
        })
        .catch((error: unknown) => {
          const target = document.querySelector('#login-error');
          if (target) target.textContent = loginError(error);
        })
        .finally(() => {
          button.disabled = false;
        });
    });
}
function shell() {
  document.documentElement.lang = 'en';
  skip.textContent = 'Skip to content';
  skip.href = '#content';
  const navigation = routes
    .map(
      ([id, text]) =>
        `<a href="#${id}" data-nav="${id}">${icon(id)}<span>${text}</span></a>`,
    )
    .join('');
  app.innerHTML = `<aside class="sidebar"><a class="wordmark" href="#overview"><span class="logo" aria-hidden="true">m<span>↗</span></span><span>miniflux<span class="light"> / ai</span></span></a><div class="nav-caption">CONSOLE</div><nav aria-label="Main">${navigation}</nav><div class="sidebar-bottom"><button class="logout" data-action="logout">${icon('logout')}Sign out</button></div></aside><div class="workspace-main"><header class="topbar"><div><span class="subtle">Console</span><span class="divider">/</span><span id="breadcrumb">Overview</span></div><span class="top-tag"><span class="dot"></span>Admin</span></header><main id="content" tabindex="-1"></main></div>`;
}
function heading(title: string) {
  return `<div class="page-heading"><h1>${title}</h1><button data-action="refresh">${icon('refresh')}Refresh</button></div>`;
}
function loadErrorView(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Connection failed. Try again.';
  return `${heading('Unable to load')}<div class="error-panel">${esc(message)}</div>`;
}

async function prepareScopeEditor(ticket: number) {
  const [settings, subscriptions] = await Promise.all([
    api<Scopes>('/admin/scopes'),
    api<Subscriptions>('/admin/subscriptions').catch(() => null),
  ]);
  if (ticket !== version || !authenticated) return undefined;
  if (scopeEditor) scopeEditor.refresh(settings, subscriptions);
  else
    scopeEditor = new ScopeEditor(
      settings,
      subscriptions,
      (data) => api<Scopes>('/admin/scopes', 'PUT', data),
      () => flash('Rules saved and applied.'),
      failed,
    );
  return scopeEditor;
}

async function render() {
  if (!authenticated) return;
  const ticket = ++version,
    current = route();
  document.querySelectorAll('[data-nav]').forEach((node) => {
    const active = (node as HTMLElement).dataset.nav === current;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  const name = routes.find(([id]) => id === current)?.[1] ?? 'Overview';
  document.querySelector('#breadcrumb')!.textContent = name;
  document.title = `${name} · miniflux-ai`;
  const content = document.querySelector<HTMLElement>('#content')!;
  content.innerHTML = '<output class="loading">Loading…</output>';
  try {
    let html: string;
    let pageScopeEditor: ScopeEditor | undefined;
    if (current === 'model') {
      model = await api<Model>('/admin/model');
      html = modelView(model);
    } else if (current === 'scopes') {
      pageScopeEditor = await prepareScopeEditor(ticket);
      html = `${heading('Processing rules')}<div id="scope-editor"></div>`;
    } else if (current === 'entries') html = await entriesView();
    else if (current === 'tasks') html = await tasksView();
    else if (current === 'system') {
      const [status, config] = await Promise.all([
        api<Status>('/admin/status'),
        api('/admin/config'),
      ]);
      html = systemView(status, config);
    } else {
      const [stats, settings] = await Promise.all([
        api<Dashboard>('/admin/stats'),
        api<Model>('/admin/model'),
      ]);
      html = overview(stats, settings);
    }
    if (ticket === version && authenticated) {
      content.innerHTML = html;
      pageScopeEditor?.mount(
        content.querySelector<HTMLElement>('#scope-editor')!,
      );
      bindForms();
    }
  } catch (error) {
    if (ticket === version && authenticated) {
      content.innerHTML = loadErrorView(error);
    }
  }
}
function overview(s: Dashboard, m: Model) {
  const t = s.features.translation,
    done = t.ready ?? 0,
    waiting = (t.pending ?? 0) + (t.processing ?? 0);
  const cards = [
    ['Entries', s.entries, 'From Miniflux', 'entries'],
    ['Translations', done, `${num(t.skipped ?? 0)} skipped`, 'success'],
    [
      'In progress',
      waiting,
      `${num(s.render_pending)} pending write-back`,
      'waiting',
    ],
    ['Failed tasks', s.tasks.dead ?? 0, 'Review in Tasks', 'danger'],
  ] as const;
  const max = Math.max(1, ...s.activity.map((d) => d.translation));
  const bars = s.activity
    .map((d, i) => {
      const h = (d.translation / max) * 120;
      return `<g><title>${d.date} · Translations: ${num(d.translation)}</title><rect class="bar-track" x="${i * 51 + 26}" y="20" width="24" height="120" rx="4"/><rect class="bar" x="${i * 51 + 26}" y="${140 - h}" width="24" height="${h}" rx="4"/><text x="${i * 51 + 38}" y="164" text-anchor="middle">${d.date.slice(5).replace('-', '/')}</text><text class="bar-value" x="${i * 51 + 38}" y="${132 - h}" text-anchor="middle">${d.translation || ''}</text></g>`;
    })
    .join('');
  const chart = `<svg class="chart" viewBox="0 0 760 200" role="img" aria-label="Daily translations over 14 days (UTC)"><path class="grid" d="M20 20H740M20 80H740M20 140H740"/>${bars}</svg>`;
  const metrics = cards
    .map(
      ([title, value, sub, color]) =>
        `<a class="stat-card" href="#${color === 'danger' ? 'tasks' : 'entries'}"><div class="stat-top">${title}<span class="stat-icon ${color}">${icon(color === 'danger' ? 'tasks' : 'entries')}</span></div><div class="stat-number">${num(value)}</div><span class="small">${sub}</span></a>`,
    )
    .join('');
  const feedRows = s.feeds
    .map((f) => {
      const failureBadge = f.translation_failed
        ? `<span class="badge danger">${f.translation_failed}</span>`
        : '—';
      return `<tr><td><span class="feed-mark" aria-hidden="true">${esc(f.title.slice(0, 1).toUpperCase())}</span>${esc(f.title)}</td><td>${num(f.entries)}</td><td>${num(f.translation_ready)}</td><td>${num(f.translation_skipped)}</td><td>${failureBadge}</td><td><button class="icon-button" data-feed="${f.feed_id}" aria-label="View entries from ${esc(f.title)}">${icon('arrow')}</button></td></tr>`;
    })
    .join('');
  const feeds = s.feeds.length
    ? `<div class="table-wrap"><table><thead><tr><th>Feed</th><th>Entries</th><th>Generated</th><th>Skipped</th><th>Failed</th><th></th></tr></thead><tbody>${feedRows}</tbody></table></div>`
    : empty('No entries yet.');
  return `${heading('Overview')}${!m.configured ? '<div class="setup-banner"><strong>Add a provider to start processing entries.</strong><a class="button primary" href="#model">Configure →</a></div>' : ''}<div class="stat-grid">${metrics}</div><div class="overview-grid"><section class="panel activity"><div class="panel-heading"><div><h2>Translation activity</h2><p>Successful generations · 14 days</p></div><span class="tag">UTC</span></div>${chart}<div class="chart-foot"><span><i></i> Generated</span><span>Updated ${esc(date(s.as_of))}</span></div></section><section class="panel pipeline"><div class="panel-heading"><h2>Output</h2></div><div class="pipeline-item"><span>Translations ready</span><strong>${num(done)}</strong></div><div class="pipeline-item"><span>Summaries ready</span><strong>${num(s.features.summary.ready ?? 0)}</strong></div><div class="pipeline-item"><span>Written to Miniflux</span><strong>${num(s.rendered)}</strong></div><div class="pipeline-item"><span>Pending write-back</span><strong>${num(s.render_pending)}</strong></div><a class="text-link" href="#tasks">View tasks ${icon('arrow')}</a></section></div><section class="panel"><div class="panel-heading"><div><h2>Feeds</h2><p>Up to 20 · Failures first</p></div><a class="text-link" href="#entries">All entries ${icon('arrow')}</a></div>${feeds}<div class="panel-foot">Skipped excludes entries outside the configured scope.</div></section>`;
}
const options = (items: string[], selected: string) =>
  items
    .map(
      (s) =>
        `<option value="${s}" ${s === selected ? 'selected' : ''}>${esc(label(s))}</option>`,
    )
    .join('');
async function entriesView() {
  const query = new URLSearchParams({
    limit: '30',
    feature: entryFilter.feature,
  });
  for (const [key, value] of Object.entries(entryFilter))
    if (value) query.set(key, value);
  if (entryCursor) query.set('before_id', String(entryCursor));
  const data = await api<EntryList>(`/admin/entries?${query}`);
  const entryRows = data.entries
    .map(
      (e) =>
        `<tr><td class="entry-title"><button class="title-button" data-entry="${e.entry_id}">${esc(e.source_title || 'Untitled')}</button><div class="small">${esc(e.source_feed_title)} <span class="mono">/ #${e.entry_id}</span></div></td><td class="mono">${esc(e.primary_language ?? 'und')}</td><td title="${esc(label(e.translation_skip_reason))}">${badge(e.translation_state)}</td><td title="${esc(label(e.summary_skip_reason))}">${badge(e.summary_state)}</td><td>${badge(e.render_status)}</td><td><button class="icon-button" data-entry="${e.entry_id}" aria-label="View entry ${e.entry_id}">${icon('arrow')}</button></td></tr>`,
    )
    .join('');
  const entriesTable = data.entries.length
    ? `<div class="table-wrap"><table><thead><tr><th>Entry</th><th>Language</th><th>Translation</th><th>Summary</th><th>Write-back</th><th></th></tr></thead><tbody>${entryRows}</tbody></table></div>`
    : empty('No matching entries.');
  return `${heading('Entries')}<section class="panel"><form id="entry-filter" class="filters"><label class="search-label">Search<input name="q" type="search" value="${esc(entryFilter.q)}" placeholder="Title or entry ID" /></label><label>Feature<select name="feature"><option value="translation" ${entryFilter.feature === 'translation' ? 'selected' : ''}>Translation</option><option value="summary" ${entryFilter.feature === 'summary' ? 'selected' : ''}>Summary</option></select></label><label>Status<select name="state"><option value="">All statuses</option>${options(['ready', 'pending', 'processing', 'scheduled', 'skipped', 'failed'], entryFilter.state)}</select></label><button type="submit">Filter</button>${entryFilter.feed_id ? '<button type="button" data-action="clear-feed">Clear feed</button>' : ''}</form>${entriesTable}<div class="pagination"><span>Entries: ${num(data.entries.length)} · Newest ID first</span><div>${entryCursor ? '<button data-action="entries-first">First page</button>' : ''}<button data-entries-next="${data.next_cursor ?? ''}" ${data.next_cursor ? '' : 'disabled'}>Next →</button></div></div></section>`;
}
function taskError(task: Task): string {
  if (!task.last_error) return '<span class="small">No errors</span>';
  const stage = task.last_error.integrity_stage
    ? ' / ' + esc(task.last_error.integrity_stage)
    : '';
  return `<div class="task-error mono">${esc(task.last_error.code)}${stage}</div>`;
}
async function tasksView() {
  const query = new URLSearchParams({ limit: '30' });
  for (const [key, value] of Object.entries(taskFilter))
    if (value) query.set(key, value);
  if (taskCursor) query.set('before_id', String(taskCursor));
  const { tasks } = await api<{ tasks: Task[] }>(`/admin/tasks?${query}`);
  const taskRows = tasks
    .map((t) => {
      const entryLabel = t.entry_id ? ` · Entry ${t.entry_id}` : '';
      return `<tr><td><strong>${esc(label(t.type))}</strong><div class="small mono">#${t.id}${entryLabel}</div></td><td>${badge(t.state)}</td><td class="mono">${t.attempts}</td><td><div>${esc(date(t.updated_at))}</div>${taskError(t)}</td><td><button data-requeue="${t.id}" ${t.requeueable ? '' : 'disabled'} title="${esc(t.requeue_reason?.code ?? 'Retry task')}" >Retry</button></td></tr>`;
    })
    .join('');
  const tasksTable = tasks.length
    ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Updated / Error</th><th>Action</th></tr></thead><tbody>${taskRows}</tbody></table></div>`
    : empty('No matching tasks.');
  return `${heading('Tasks')}<section class="panel"><form id="task-filter" class="filters"><label>Status<select name="state"><option value="">All statuses</option>${options(['pending', 'leased', 'done', 'dead'], taskFilter.state)}</select></label><label>Type<select name="type"><option value="">All types</option>${options(['generate_artifacts', 'render', 'digest', 'ingest_backfill'], taskFilter.type)}</select></label><button type="submit">Filter</button></form>${tasksTable}<div class="pagination"><span>Tasks: ${num(tasks.length)}</span><div>${taskCursor ? '<button data-action="tasks-first">First page</button>' : ''}<button data-tasks-next="${tasks.at(-1)?.id ?? ''}" ${tasks.length === 30 ? '' : 'disabled'}>Next →</button></div></div></section><p class="help">Check entry details for source mismatches before retrying.</p>`;
}
let providerFieldId = 0;
function providerCard(p?: Model['providers'][number]) {
  const id = ++providerFieldId;
  const field = (name: string) => `provider_${id}_${name}`;
  const status = p?.health.state ?? 'healthy';
  const healthLabels = {
    healthy: 'Standby',
    cooling: 'Cooling down',
    recovering: 'Awaiting retry',
    probing: 'Probing',
    disabled: 'Disabled',
  };
  const recovery = p?.health.retry_at
    ? `<p class="help">Retry after: ${esc(date(new Date(p.health.retry_at).toISOString()))}</p>`
    : '';
  const lastFailure = p?.health.last_failure
    ? `<p class="help">Last error: <span class="mono">${esc(p.health.last_failure)}</span></p>`
    : '';
  return `<fieldset class="provider-card" data-provider="${id}"><legend>${esc(p?.id ?? 'New provider')}</legend><div class="provider-heading"><span class="badge ${status === 'cooling' ? 'waiting' : 'muted'}">${healthLabels[status]}</span><button type="button" data-action="remove-provider" aria-label="Remove ${esc(p?.id ?? 'New provider')}">Remove</button></div><div class="provider-pair"><label>Provider ID<input name="${field('id')}" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" value="${esc(p?.id ?? '')}" placeholder="primary" /></label><label>Priority<input name="${field('priority')}" type="number" required min="0" max="9007199254740991" step="1" value="${p?.priority ?? 100}" /></label></div><label>API Base URL<input name="${field('base_url')}" type="url" required maxlength="2048" value="${esc(p?.base_url ?? '')}" placeholder="https://api.example.com/v1" /></label><label>Model<input name="${field('model')}" required maxlength="256" value="${esc(p?.model ?? '')}" placeholder="Model ID" /></label><label>API Key <span class="optional">${p?.api_key_configured ? 'Saved' : 'Required'}</span><input name="${field('api_key')}" type="password" autocomplete="new-password" maxlength="4096" placeholder="${p?.api_key_configured ? 'Leave blank to keep current key' : 'Enter API key'}" /></label><p class="help">New provider IDs or URLs require a key.</p><div class="provider-pair"><label>Timeout (s)<input name="${field('timeout')}" type="number" min="0.001" max="600" step="0.001" required value="${(p?.request_timeout_ms ?? 180000) / 1000}" /></label><label class="provider-enabled"><input name="${field('enabled')}" type="checkbox" ${p?.enabled !== false ? 'checked' : ''} />Enabled</label></div>${recovery}${lastFailure}</fieldset>`;
}
function modelView(m: Model) {
  providerFieldId = 0;
  return `${heading('Models')}<div class="settings-grid"><section class="panel settings-panel"><div class="panel-heading"><div><h2>Providers</h2><p>Higher priority first; list order breaks ties.</p></div><span class="badge ${m.configured ? 'success' : 'waiting'}">${m.configured ? 'Configured' : 'Not configured'}</span></div><form id="model-form"><div id="provider-list">${m.providers.length ? m.providers.map((p) => providerCard(p)).join('') : providerCard()}</div><button type="button" data-action="add-provider">＋ Add provider</button><div class="failover-settings"><h3>Failover</h3><div class="provider-pair"><label>Failure threshold<input name="failure_threshold" type="number" required min="1" max="100" step="1" value="${m.failover.failure_threshold}" /></label><label>Cooldown<input name="cooldown" required pattern="[1-9][0-9]*[smhd]" value="${esc(m.failover.cooldown)}" placeholder="5m" /></label></div><p class="help">Consecutive failures before cooldown. Use s, m, h or d; upstream retry delays may extend it.</p></div>${m.restart_required ? '<p class="form-error">Restart to apply other configuration changes.</p>' : ''}<div class="form-actions"><span class="small">Applies to new calls</span><button class="primary" type="submit">Save ${icon('arrow')}</button></div></form></section><aside class="settings-aside"><h2>Compatibility</h2><p>Chat Completions with JSON output. Supports JSON and SSE responses.</p><div class="aside-note"><strong>Provider health</strong><p>Based on model calls. Saving does not test connectivity; refresh to update status.</p></div></aside></div>`;
}
function systemView(s: Status, config: unknown) {
  return `${heading('System')}<div class="stat-grid"><div class="stat-card"><div class="stat-top">Database</div><div class="stat-word">${s.core.database ? 'OK' : 'Error'}</div><span class="small">SQLite</span></div><div class="stat-card"><div class="stat-top">Miniflux</div><div class="stat-word">${s.core.ready ? 'Connected' : 'Unavailable'}</div><span class="small">${esc(s.core.version ?? s.core.reason ?? 'Awaiting check')}</span></div><div class="stat-card wide"><div class="stat-top">Account binding</div><div class="stat-word">${esc(s.miniflux_account_binding.state)}</div><span class="small">${esc(s.miniflux_account_binding.configured_base_url)}</span></div></div><section class="panel diagnostic"><h2>Diagnostics</h2><pre>${esc(JSON.stringify(s, null, 2))}</pre></section><section class="panel diagnostic"><h2>Configuration <span class="tag">Read-only · Keys hidden</span></h2><p class="subtle">Edit providers in <a href="#model">Models</a>. Other changes require a restart.</p><pre>${esc(JSON.stringify(config, null, 2))}</pre></section>`;
}
function formText(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value : '';
}
function bindForms() {
  for (const id of ['entry-filter', 'task-filter', 'model-form'])
    document.getElementById(id)?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement,
        values = new FormData(form);
      if (id === 'entry-filter') {
        entryFilter = {
          ...entryFilter,
          q: formText(values, 'q'),
          state: formText(values, 'state'),
          feature: formText(values, 'feature'),
        };
        entryCursor = null;
        void render();
      } else if (id === 'task-filter') {
        taskFilter = {
          state: formText(values, 'state'),
          type: formText(values, 'type'),
        };
        taskCursor = null;
        void render();
      } else {
        const button = form.querySelector<HTMLButtonElement>(
          'button[type=submit]',
        )!;
        button.disabled = true;
        void api<Model>('/admin/model', 'PUT', {
          revision: model!.revision,
          failover: {
            cooldown: formText(values, 'cooldown'),
            failure_threshold: Number(values.get('failure_threshold')),
          },
          providers: [
            ...form.querySelectorAll<HTMLElement>('[data-provider]'),
          ].map((card) => {
            const get = (name: string) =>
              formText(values, `provider_${card.dataset.provider}_${name}`);
            return {
              id: get('id'),
              priority: Number(get('priority')),
              enabled: get('enabled') === 'on',
              base_url: get('base_url'),
              model: get('model'),
              api_key: get('api_key'),
              request_timeout_ms: Math.round(Number(get('timeout')) * 1000),
            };
          }),
        })
          .then(() => {
            form.reset();
            flash('Settings saved.');
            return render();
          })
          .catch(failed)
          .finally(() => {
            button.disabled = false;
          });
      }
    });
}
async function showEntry(id: number) {
  const ticket = version;
  const data = await api<{
    source_title: string;
    source: { title: string; content: string };
    feature_states: {
      kind: string;
      state: string;
      skip_reason: string | null;
    }[];
    render_status: string;
    primary_language: string | null;
    tasks: Task[];
  }>(`/admin/entries/${id}`);
  if (!authenticated || ticket !== version) return;
  const featureStates = data.feature_states
    .map((f) => {
      const skipReason = f.skip_reason
        ? `<small>${esc(label(f.skip_reason))}</small>`
        : '';
      return `<div><span>${f.kind === 'translation' ? 'Translation' : 'Summary'}</span>${badge(f.state)}${skipReason}</div>`;
    })
    .join('');
  const errorRows = data.tasks
    .filter((t) => t.last_error)
    .map(
      (t) =>
        `<p class="task-error mono">#${t.id} · ${esc(t.last_error!.code)} ${esc(t.last_error!.integrity_stage)}</p>`,
    )
    .join('');
  const taskErrors = data.tasks.some((t) => t.last_error)
    ? `<h3>Task errors</h3>${errorRows}`
    : '';
  dialog.innerHTML = `<div class="dialog-head"><div><span class="eyebrow">ENTRY / ${id}</span><h2 id="dialog-title">${esc(data.source_title)}</h2></div><button data-action="close-dialog" aria-label="Close details">×</button></div><div class="dialog-body"><div class="detail-states">${featureStates}<div><span>Write-back</span>${badge(data.render_status)}</div><div><span>Language</span><strong>${esc(data.primary_language ?? 'und')}</strong></div></div><h3>Regenerate</h3><p class="help">Replaces generated content in Miniflux. Source is preserved.</p><div class="actions"><button data-reprocess="${id}" data-feature="translation">Retranslate</button><button data-reprocess="${id}" data-feature="summary">Regenerate summary</button></div>${
    taskErrors
  }<details><summary>Source HTML</summary><pre class="source">${esc(data.source.content)}</pre></details></div>`;
  dialog.showModal();
}
async function namedAction(target: HTMLElement) {
  switch (target.dataset.action) {
    case 'add-provider': {
      const list = document.querySelector('#provider-list')!;
      if (list.children.length >= 32)
        throw new Error('Up to 32 providers allowed.');
      list.insertAdjacentHTML('beforeend', providerCard());
      list.lastElementChild?.querySelector('input')?.focus();
      break;
    }
    case 'remove-provider':
      target.closest('[data-provider]')?.remove();
      break;
    case 'logout':
      if (
        scopeEditor?.hasUnsaved() &&
        !confirm('Discard unsaved rules and sign out?')
      )
        return;
      await api('/auth/session', 'DELETE');
      notice.textContent = '';
      login();
      break;
    case 'refresh':
      await render();
      break;
    case 'close-dialog':
      dialog.close();
      break;
  }
}
async function action(target: HTMLElement) {
  await namedAction(target);
  if (target.dataset.feed) {
    entryFilter.feed_id = target.dataset.feed;
    entryCursor = null;
    location.hash = 'entries';
  }
  if (target.dataset.action === 'clear-feed') {
    entryFilter.feed_id = '';
    entryCursor = null;
    await render();
  }
  if (target.dataset.action === 'entries-first' || target.dataset.entriesNext) {
    entryCursor = target.dataset.entriesNext
      ? Number(target.dataset.entriesNext)
      : null;
    await render();
  }
  if (target.dataset.action === 'tasks-first' || target.dataset.tasksNext) {
    taskCursor = target.dataset.tasksNext
      ? Number(target.dataset.tasksNext)
      : null;
    await render();
  }
  if (target.dataset.entry) await showEntry(Number(target.dataset.entry));
  if (
    target.dataset.requeue &&
    confirm('Retry this task? This may call a model or write to Miniflux.')
  ) {
    await api(`/admin/tasks/${target.dataset.requeue}/requeue`, 'POST');
    flash('Task queued.');
    await render();
  }
  if (
    target.dataset.reprocess &&
    confirm(
      `Regenerate ${target.dataset.feature === 'translation' ? 'translation' : 'summary'}? This calls a model and replaces the current content.`,
    )
  ) {
    const result = await api<{ outcomes: Record<string, string> }>(
      `/admin/entries/${target.dataset.reprocess}/reprocess?features=${target.dataset.feature}`,
      'POST',
    );
    flash(
      `Result: ${Object.values(result.outcomes)
        .map((s) => label(s))
        .join(', ')}`,
    );
    dialog.close();
    await render();
  }
}
document.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>(
    '[data-action], [data-feed], [data-requeue], [data-reprocess], [data-entry], [data-entries-next], [data-tasks-next]',
  );
  if (
    !target ||
    (target as HTMLButtonElement).disabled ||
    (target.closest('form') && (target as HTMLButtonElement).type === 'submit')
  )
    return;
  target.setAttribute('disabled', '');
  void action(target)
    .catch(failed)
    .finally(() => target.removeAttribute('disabled'));
});
skip.addEventListener('click', (event) => {
  event.preventDefault();
  app.querySelector<HTMLElement>('main')?.focus();
});
window.addEventListener('hashchange', () => {
  notice.textContent = '';
  void render();
});
window.addEventListener('beforeunload', (event) => {
  if (scopeEditor?.hasUnsaved()) event.preventDefault();
});
try {
  await api<Model>('/admin/model');
  authenticated = true;
  shell();
  await render();
} catch (error) {
  login();
  if (!(error instanceof HttpError && error.status === 401)) failed(error);
}
