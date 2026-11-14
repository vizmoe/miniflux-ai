import { describe, expect, it } from 'vitest';
import {
  LanguageDetector,
  classifyParts,
  partEvidence,
} from '../src/lang/index.js';
import { lexicalUnits } from '../src/html/units.js';

const detector = (language: string, reliable = true) => ({
  detect: () => ({ language, isReliable: () => reliable }),
});
const han = '这是中文正文用于说明系统如何处理文章内容并保留所有重要信息'.repeat(
  3,
);
describe('two-stage article-language evidence', () => {
  it('ignores short parts, caps titles/body parts and downweights unreliable evidence', () => {
    expect(partEvidence('Short heading', true, detector('en'))).toEqual({
      language: null,
      reliable: false,
      weight: 0,
    });
    const words = 'ordinary '.repeat(25);
    expect(partEvidence(words, false, detector('en'))).toMatchObject({
      weight: 6.25,
    });
    expect(partEvidence(words, false, detector('en', false))).toMatchObject({
      weight: 1.5625,
    });
    expect(
      partEvidence('ordinary '.repeat(600), false, detector('en')).weight,
    ).toBe(500);
    expect(
      partEvidence('ordinary '.repeat(600), true, detector('en')).weight,
    ).toBe(50);
    expect(partEvidence('ordinary '.repeat(50), false, detector(''))).toEqual({
      language: null,
      reliable: true,
      weight: 0,
    });
  });
  it('resolves CJK script signals in their required order and retains unknown conflicts', () => {
    expect(partEvidence(han, false, detector('en'))).toMatchObject({
      language: 'zh',
      reliable: true,
    });
    expect(partEvidence(han, false, detector('zh', false))).toMatchObject({
      language: 'zh',
      reliable: false,
    });
    expect(partEvidence(han, false, detector('ja'))).toMatchObject({
      language: 'ja',
      reliable: true,
    });
    expect(partEvidence(han, false, detector('ru'))).toMatchObject({
      language: null,
      weight: 0,
    });
    const kana = 'あいうえおかきくけこ'.repeat(5),
      hangul = '한국어문장내용정보'.repeat(5);
    expect(
      partEvidence(kana + '中文', false, detector('en', false)),
    ).toMatchObject({ language: 'ja', reliable: true });
    expect(
      partEvidence(hangul + '中文', false, detector('en', false)),
    ).toMatchObject({ language: 'ko', reliable: true });
    expect(partEvidence(kana + hangul, false, detector('zh'))).toMatchObject({
      language: null,
      reliable: false,
      weight: 0,
    });
    expect(lexicalUnits('https://host.test/' + han).count).toBe(0);
  });
  it('requires a 70% primary share and at least one reliable winning part', () => {
    const evidence = (weight: number, reliable = true) => ({
      language: 'en',
      weight,
      reliable,
    });
    expect(
      classifyParts([
        evidence(70),
        { language: 'zh', weight: 30, reliable: true },
      ]),
    ).toEqual({ primaryLanguage: 'en', languageConfidence: 0.7 });
    expect(
      classifyParts([
        evidence(69),
        { language: 'zh', weight: 31, reliable: true },
      ]),
    ).toEqual({ primaryLanguage: null, languageConfidence: null });
    expect(classifyParts([evidence(100, false)])).toEqual({
      primaryLanguage: null,
      languageConfidence: null,
    });
    expect(classifyParts([])).toEqual({
      primaryLanguage: null,
      languageConfidence: null,
    });
    expect(
      classifyParts([
        evidence(30),
        evidence(40, false),
        { language: 'zh', weight: 30, reliable: true },
      ]).languageConfidence,
    ).toBe(0.7);
  });
  it('uses the pinned ELD medium corpus for prose and prevents a short title overriding the body', async () => {
    const language = await LanguageDetector.create();
    const english =
      'The software service reads articles from an existing database and produces independent translations and summaries. Each task stores its configuration so that a later retry uses exactly the same instructions. The original article remains under the control of its owner and every generated paragraph can be removed without changing the source.';
    expect(
      language.analyze('', [{ id: 'english', text: english }]).primaryLanguage,
    ).toBe('en');
    expect(
      language.analyze('English title for a Chinese article', [
        { id: 'chinese', text: han },
      ]).primaryLanguage,
    ).toBe('zh');
    expect(
      language.analyze('', [
        {
          id: 'japanese',
          text: '日本語の文章について説明します。これは記事の情報を安全に扱うための仕組みです。内容を翻訳して読みやすい要約を作成します。'.repeat(
            3,
          ),
        },
      ]).primaryLanguage,
    ).toBe('ja');
    expect(
      language.analyze('', [
        {
          id: 'korean',
          text: '이 서비스는 원본 문서의 내용을 보존하면서 번역과 요약을 독립적으로 생성합니다. 저장된 정보를 안전하게 처리하고 중요한 내용을 전달합니다.'.repeat(
            3,
          ),
        },
      ]).primaryLanguage,
    ).toBe('ko');
    expect(language.analyze('123 https://example.test', [])).toEqual({
      primaryLanguage: null,
      languageConfidence: null,
    });
  });
});
