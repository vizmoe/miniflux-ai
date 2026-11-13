import { eld } from 'eld';
import type { SemanticBlock } from '../html/blocks.js';
export interface LanguageFacts {
  primaryLanguage: string | null;
  languageConfidence: number | null;
}
export interface PartEvidence {
  language: string | null;
  reliable: boolean;
  weight: number;
}
export interface LocalDetector {
  detect(text: string): { language: string; isReliable(): boolean };
}
import * as C from '../config/constants.js';
import { lexicalUnits, isUsableSourceTitle } from '../html/units.js';
function evidenceWeight(
  count: number,
  title: boolean,
  language: string | null,
  reliable: boolean,
) {
  if (language === null) return 0;
  const cap = title ? C.LANGUAGE_TITLE_WEIGHT_CAP : C.LANGUAGE_PART_MAX_WEIGHT;
  const lengthFactor =
    count < C.LANGUAGE_PART_FULL_WEIGHT_UNITS
      ? C.LANGUAGE_PART_SHORT_WEIGHT_FACTOR
      : 1;
  const reliabilityFactor = reliable ? 1 : C.UNRELIABLE_WEIGHT_FACTOR;
  return Math.min(count, cap) * lengthFactor * reliabilityFactor;
}
export function partEvidence(
  text: string,
  title: boolean,
  detector: LocalDetector,
): PartEvidence {
  const u = lexicalUnits(text);
  if (u.count < C.LANGUAGE_PART_MIN_UNITS)
    return { language: null, reliable: false, weight: 0 };
  const result = detector.detect(u.cleaned);
  let language = result.language || null,
    reliable = result.isReliable();
  const cjk = u.han_units + u.kana_units + u.hangul_units;
  const kana =
    u.kana_units >= C.KANA_HANGUL_SIGNAL_MINIMUM_UNITS &&
    u.kana_units / cjk >= C.KANA_HANGUL_SIGNAL_MINIMUM_CJK_SHARE;
  const hangul =
    u.hangul_units >= C.KANA_HANGUL_SIGNAL_MINIMUM_UNITS &&
    u.hangul_units / cjk >= C.KANA_HANGUL_SIGNAL_MINIMUM_CJK_SHARE;
  const strongHan =
    u.han_units >= C.SCRIPT_GUARD_MINIMUM_HAN_UNITS &&
    u.han_units / (u.han_units + u.latin_words) >=
      C.SCRIPT_GUARD_MINIMUM_HAN_SHARE;
  if (kana && hangul) {
    language = null;
    reliable = false;
  } else if (kana) {
    language = 'ja';
    reliable = true;
  } else if (hangul) {
    language = 'ko';
    reliable = true;
  } else if (strongHan) {
    if (language === 'en') {
      language = 'zh';
      reliable = true;
    } else if (language !== 'zh' && language !== 'ja') {
      language = null;
      reliable = false;
    }
  }
  const weight = evidenceWeight(u.count, title, language, reliable);
  return { language, reliable, weight };
}
export function classifyParts(parts: PartEvidence[]): LanguageFacts {
  const aggregate = new Map<string, { weight: number; reliable: number }>();
  let total = 0;
  for (const part of parts)
    if (part.language && part.weight > 0) {
      const prior = aggregate.get(part.language) ?? { weight: 0, reliable: 0 };
      prior.weight += part.weight;
      prior.reliable += Number(part.reliable);
      total += part.weight;
      aggregate.set(part.language, prior);
    }
  const first = [...aggregate].sort(
    (a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]),
  )[0];
  return first &&
    first[1].weight / total >= C.ARTICLE_PRIMARY_SHARE &&
    first[1].reliable >= C.ARTICLE_PRIMARY_MIN_RELIABLE_PARTS
    ? { primaryLanguage: first[0], languageConfidence: first[1].weight / total }
    : { primaryLanguage: null, languageConfidence: null };
}
export class LanguageDetector {
  detector;
  constructor(detector: LocalDetector) {
    this.detector = detector;
  }
  static async create() {
    // eld's root entry is dynamic; its shared declaration also covers static entries.
    const detector = eld.newInstance();
    if (!('load' in detector) || typeof detector.load !== 'function')
      throw new Error('language_loader_unavailable');
    await detector.load(C.ELD_DATABASE);
    return new LanguageDetector(detector);
  }
  analyze(title: string, blocks: SemanticBlock[]): LanguageFacts {
    return classifyParts([
      ...(isUsableSourceTitle(title)
        ? [partEvidence(title, true, this.detector)]
        : []),
      ...blocks.map((b) => partEvidence(b.text, false, this.detector)),
    ]);
  }
}
