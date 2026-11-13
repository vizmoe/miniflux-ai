import { z } from 'zod';
import type { YamlConfiguration } from '../config/store.js';
import type { Config } from '../config/index.js';
import type { Scope } from '../config/scope.js';
import { ConfigurationError } from '../config/index.js';
import { canonicalJson, safeId } from '../config/primitives.js';
import { scopeLocation } from '../config/scope.js';
import { ApiError } from '../obs/errors.js';
const ids = z
  .array(safeId)
  .max(10000)
  .transform((values) => [...new Set(values)].sort((a, b) => a - b));
const list = z.object({ feed_ids: ids, category_ids: ids }).strict();
const updateSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    target: z
      .string()
      .regex(/^(?:translation|summary|digest:[a-z0-9][a-z0-9_-]{0,63})$/),
    fallback_action: z.enum(['allow', 'deny']),
    allowlist: list,
    blocklist: list,
  })
  .strict();
/** A deny-then-allow prefix is equivalent to lists with blocklist priority.
 * Stop before any rule whose order or combined predicates carry other meaning.
 */
function lists(scope: Scope) {
  const prefix: Scope['rules'] = [];
  let allowing = false;
  for (const rule of scope.rules) {
    if (
      (allowing && rule.action === 'deny') ||
      Object.keys(rule.match).length !== 1 ||
      (!rule.match.feed_ids && !rule.match.category_ids)
    )
      break;
    allowing ||= rule.action === 'allow';
    prefix.push(rule);
  }
  const collect = (
    action: 'allow' | 'deny',
    key: 'feed_ids' | 'category_ids',
  ) =>
    [
      ...new Set(
        prefix
          .filter((rule) => rule.action === action)
          .flatMap((rule) => rule.match[key] ?? []),
      ),
    ].sort((a, b) => a - b);
  return {
    prefix,
    allowlist: {
      feed_ids: collect('allow', 'feed_ids'),
      category_ids: collect('allow', 'category_ids'),
    },
    blocklist: {
      feed_ids: collect('deny', 'feed_ids'),
      category_ids: collect('deny', 'category_ids'),
    },
    other_rules: scope.rules.slice(prefix.length),
  };
}
function withLists(scope: Scope, data: z.infer<typeof updateSchema>): Scope {
  const current = lists(scope);
  const names = new Set(current.other_rules.map((rule) => rule.name));
  const rules = [];
  for (const [action, selected] of [
    ['deny', data.blocklist],
    ['allow', data.allowlist],
  ] as const) {
    for (const key of ['feed_ids', 'category_ids'] as const) {
      if (!selected[key].length) continue;
      const base =
        current.prefix.find((rule) => rule.action === action && rule.match[key])
          ?.name ??
        `${action === 'deny' ? 'block' : 'allow'}-${key === 'feed_ids' ? 'feeds' : 'categories'}`;
      let name = base,
        suffix = 2;
      while (names.has(name)) name = `${base}-${suffix++}`;
      names.add(name);
      rules.push({ name, action, match: { [key]: selected[key] } });
    }
  }
  return {
    fallback_action: data.fallback_action,
    rules: [...rules, ...current.other_rules],
  };
}
export class ScopeSettings {
  configuration;
  active;
  constructor(configuration: YamlConfiguration, active: Config) {
    this.configuration = configuration;
    this.active = active;
  }
  view() {
    const { config, revision } = this.configuration.read();
    const describe = (id: string, name: string, enabled: boolean) => {
      const scope = scopeLocation(config, id)!.owner.scope;
      const active = scopeLocation(this.active, id);
      const { allowlist, blocklist, other_rules } = lists(scope);
      return {
        id,
        name,
        enabled,
        allowlist,
        blocklist,
        other_rules,
        fallback_action: scope.fallback_action,
        available: Boolean(active),
        applied: Boolean(
          active && canonicalJson(active.owner.scope) === canonicalJson(scope),
        ),
      };
    };
    return {
      source: 'yaml',
      revision,
      targets: [
        describe(
          'translation',
          'Translation',
          config.features.translation.enabled,
        ),
        describe('summary', 'Summary', config.features.summary.enabled),
        ...config.features.digest.jobs.map((job) =>
          describe(
            `digest:${job.id}`,
            `Digest · ${job.id}`,
            config.features.digest.enabled,
          ),
        ),
      ],
    };
  }
  update(input: unknown) {
    const data = updateSchema.parse(input);
    const active = scopeLocation(this.active, data.target);
    if (!active) throw new ApiError(404, 'scope_not_found');
    try {
      const { config } = this.configuration.updateScope(
        data.revision,
        data.target,
        (scope) => withLists(scope, data),
      );
      // File replacement and scope activation are synchronous. Existing tasks
      // retain snapshots; subsequent admissions read this complete new Scope.
      active.owner.scope = structuredClone(
        scopeLocation(config, data.target)!.owner.scope,
      );
    } catch (error) {
      if (error instanceof ConfigurationError)
        throw new ApiError(400, 'invalid_configuration', {
          paths: error.paths,
        });
      throw error;
    }
    return this.view();
  }
}
