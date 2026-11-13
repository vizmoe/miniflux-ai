import { canonicalTree, isElement, parseSource } from './dom.js';
import { trimTrailingCharacters } from '../runtime/text.js';
// Sanitizer data adapted from Miniflux; Copyright The Miniflux Authors.
// Apache-2.0; see THIRD_PARTY_NOTICES.md and licenses/Miniflux-Apache-2.0.txt.
type ResourceResolver = (value: string) => string | null;
const allowed = new Map<string, Set<string>>();
for (const tag of 'aside blockquote b br caption cite code del dfn em figcaption figure hr i ins kbd p picture pre rp rt rtc ruby s small samp strong sub table tfoot thead tr u var wbr annotation annotation-xml maction merror mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics'.split(
  ' ',
))
  allowed.set(tag, new Set());
for (const tag of 'dd dl dt h1 h2 h3 h4 h5 h6 li ol sup ul'.split(' '))
  allowed.set(tag, new Set(['id']));
for (const [tag, attrs] of Object.entries({
  a: 'href title id',
  abbr: 'title',
  acronym: 'title',
  audio: 'src',
  iframe: 'width height frameborder src allowfullscreen',
  img: 'alt title src srcset sizes width height fetchpriority decoding',
  q: 'cite',
  source: 'src type srcset sizes media',
  td: 'rowspan colspan',
  th: 'rowspan colspan',
  time: 'datetime',
  video: 'poster height width src',
  math: 'xmlns',
}))
  allowed.set(tag, new Set(attrs.split(' ')));
const iframeHosts = new Set(
  'bandcamp.com cdn.embedly.com dailymotion.com open.spotify.com player.bilibili.com player.twitch.tv player.vimeo.com soundcloud.com vk.com w.soundcloud.com youtube-nocookie.com youtube.com'.split(
    ' ',
  ),
);
const schemes = new Set(
  'https: http: apt: bitcoin: callto: dav: davs: ed2k: facetime: feed: ftp: geo: git: gopher: irc: irc6: ircs: itms-apps: itms: magnet: mailto: news: nntp: rtmp: sftp: sip: sips: skype: spotify: ssh: steam: svn: svn+ssh: tel: webcal: xmpp: opener: hack:'.split(
    ' ',
  ),
);
const blockedResources = [
  'api.flattr.com',
  'www.facebook.com/sharer.php',
  'feeds.feedburner.com',
  'feedsportal.com',
  'linkedin.com/shareArticle',
  'pinterest.com/pin/create/button/',
  'stats.wordpress.com',
  'twitter.com/intent/tweet',
  'twitter.com/share',
  'x.com/intent/tweet',
  'x.com/share',
];
export function allowedSourceAttributes(element: Element): [string, string][] {
  return Array.from(element.attributes)
    .filter((a) => allowed.get(element.localName)?.has(a.name))
    .map((a) => [a.name, a.value]);
}
export function sanitize(content: string, baseUrl: string) {
  const root = parseSource(content);
  sanitizeTree(root, baseUrl);
  return root.innerHTML;
}
function skipSrcsetSeparators(value: string, position: number) {
  while (position < value.length && /[\t\n\f\r ,]/.test(value[position]))
    position++;
  return position;
}
function srcsetCandidates(value: string) {
  const candidates = [];
  const space = /[\t\n\f\r ]/;
  let position = 0;
  while (position < value.length) {
    position = skipSrcsetSeparators(value, position);
    const start = position;
    // Miniflux reads the URL up to ASCII whitespace, preserving embedded
    // commas in CDN paths and queries. Only trailing commas end a bare URL.
    while (position < value.length && !space.test(value[position])) position++;
    let url = value.slice(start, position);
    if (!url) break;
    let descriptor = '';
    if (url.endsWith(',')) url = trimTrailingCharacters(url, ',');
    else {
      const descriptorStart = position;
      while (position < value.length && value[position] !== ',') position++;
      descriptor = value
        .slice(descriptorStart, position)
        .replace(/[\t\n\f\r ]+/g, ' ')
        .trim();
    }
    candidates.push([url, descriptor]);
  }
  return candidates;
}
function sourceResource(value: string, baseUrl: string) {
  if (blockedResources.some((v) => value.includes(v))) return null;
  try {
    // Miniflux preserves absolute URL spelling and forces network paths to
    // HTTPS. WHATWG serialization would rewrite stored Source attributes.
    let resolved = value.startsWith('//') ? `https:${value}` : value;
    let url;
    try {
      url = new URL(resolved);
    } catch {
      url = new URL(resolved, baseUrl);
      resolved = url.toString();
    }
    return schemes.has(url.protocol) ? resolved : null;
  } catch {
    return null;
  }
}
function iframeResource(value: string) {
  try {
    const url = new URL(value),
      host = url.hostname.replace(/^www\./, '');
    if (!iframeHosts.has(host)) return null;
    if (host === 'youtube.com' && url.pathname.startsWith('/embed/')) {
      url.hostname = 'www.youtube-nocookie.com';
      value = url.toString();
    }
    if (
      host === 'player.vimeo.com' &&
      url.pathname.startsWith('/video/') &&
      !url.searchParams.has('dnt')
    ) {
      url.searchParams.set('dnt', '1');
      value = url.toString();
    }
    return value;
  } catch {
    return null;
  }
}
function srcsetResource(value: string, resource: ResourceResolver) {
  const candidates = srcsetCandidates(value).flatMap(([url, descriptor]) => {
    const cleaned = resource(url);
    if (!cleaned) return [];
    const suffix = descriptor ? ' ' + descriptor : '';
    return [cleaned + suffix];
  });
  return candidates.join(', ') || null;
}
function validImageAttribute(key: string, value: string) {
  if (['width', 'height'].includes(key)) return /^\+?[1-9]\d*$/.test(value);
  if (key === 'decoding') return ['sync', 'async', 'auto'].includes(value);
  if (key === 'fetchpriority') return ['high', 'low', 'auto'].includes(value);
  return true;
}
function resourceAttribute(
  tag: string,
  key: string,
  value: string,
  resource: ResourceResolver,
) {
  if (tag === 'iframe') return iframeResource(value);
  if (
    tag === 'img' &&
    key === 'src' &&
    /^data:image\/(avif|apng|png|svg|jpg|jpeg|gif|webp)/.test(value)
  )
    return value;
  if (tag === 'a' && key === 'href' && value.startsWith('#')) return value;
  return resource(value);
}
function attributeValue(
  tag: string,
  attribute: Attr,
  resource: ResourceResolver,
) {
  const { name: key, value } = attribute;
  if (!allowed.get(tag)!.has(key)) return null;
  if (tag === 'math' && key === 'xmlns')
    return 'http://www.w3.org/1998/Math/MathML';
  if (tag === 'img' && !validImageAttribute(key, value)) return null;
  if (['img', 'source'].includes(tag) && key === 'srcset')
    return srcsetResource(value, resource);
  if (['src', 'href', 'poster', 'cite'].includes(key))
    return resourceAttribute(tag, key, value, resource);
  return value;
}
function discardElement(node: Element) {
  return (
    ['noscript', 'script', 'style'].includes(node.localName) ||
    node.hasAttribute('hidden') ||
    (node.localName === 'img' &&
      ['0', '1'].includes(node.getAttribute('height') ?? '') &&
      ['0', '1'].includes(node.getAttribute('width') ?? ''))
  );
}
function lacksRequiredResource(node: Element) {
  const tag = node.localName;
  return (
    (tag === 'a' && !node.hasAttribute('href')) ||
    (tag === 'iframe' && !node.hasAttribute('src')) ||
    (['img', 'source'].includes(tag) &&
      !node.hasAttribute('src') &&
      !node.hasAttribute('srcset'))
  );
}
function presentationAttributes(node: Element) {
  const tag = node.localName;
  if (tag === 'a' && !node.getAttribute('href')!.startsWith('#')) {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
  if (['audio', 'video'].includes(tag)) node.setAttribute('controls', '');
  if (tag === 'img') node.setAttribute('loading', 'lazy');
  if (tag === 'iframe') {
    node.replaceChildren();
    node.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    node.setAttribute('loading', 'lazy');
    if (/youtube(?:-nocookie)?\.com/.test(node.getAttribute('src')!))
      node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  }
}
/** Sanitizes an already parsed, caller-owned tree using the same model. */
export function sanitizeTree(root: Element, baseUrl: string) {
  const resource = (value: string) => sourceResource(value, baseUrl);
  const walk = (node: ChildNode, depth: number): void => {
    if (depth > 510) throw new Error('sanitizer_depth_exceeded');
    if (node.nodeType === 8) {
      node.remove();
      return;
    }
    if (!isElement(node)) return;
    if (discardElement(node)) {
      node.remove();
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child, depth + 1);
    if (!allowed.has(node.localName)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    const attributes = Array.from(node.attributes);
    for (const a of attributes) node.removeAttribute(a.name);
    for (const attribute of attributes) {
      const value = attributeValue(node.localName, attribute, resource);
      if (value !== null) node.setAttribute(attribute.name, value);
    }
    if (lacksRequiredResource(node)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    presentationAttributes(node);
  };
  for (const child of Array.from(root.childNodes)) walk(child, 0);
}
/** Extra upstream presentation attributes are outside the Source signature. */
export function canonicalSanitizerTree(content: string | Element) {
  return canonicalTree(
    typeof content === 'string' ? parseSource(content) : content,
    allowedSourceAttributes,
  );
}
