import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STRINGS, debugText, langFrom, t } from '../../packages/mod/hooks/i18n.ts'
import type { Key, Lang } from '../../packages/mod/hooks/i18n.ts'
import { formatStats, emptyStats } from '../../packages/mod/hooks/stats.ts'
import { clip, displayWidth } from '../../packages/mod/hooks/ui/theme.ts'

test('langFrom recognizes supported locale tags and native language names', () => {
  const cases: Record<Lang, string[]> = {
    ko: ['ko', 'ko_KR', 'ko-KR', 'Korean', '한국어', ' KO_kr.UTF-8 '],
    en: ['en', 'English', 'en_US.UTF-8'],
    zh: ['zh', 'zh-Hans', 'zh_CN', 'Chinese', '简体中文', '中文'],
    ja: ['ja', 'ja_JP', 'Japanese', '日本語'],
    es: ['es', 'es_ES', 'Spanish', 'Español'],
    pt: ['pt', 'pt_BR', 'Portuguese', 'Português'],
    fr: ['fr', 'fr_FR', 'fr-CA', 'fr_BE.UTF-8', 'fr@euro', 'FR_ch', 'French', 'Français', 'francais', ' fr_FR.UTF-8 '],
  }
  for (const [lang, values] of Object.entries(cases)) for (const value of values) assert.equal(langFrom(value), lang, value)
  for (const value of [undefined, '', ' ', 'auto', 'C', 'C.UTF-8', 'POSIX', 'fra', 'frisian', 'french-ish', 'korean-ish', 'constructor']) assert.equal(langFrom(value), undefined)
})

test('every table matches English in keys, placeholders and edge whitespace', () => {
  const english = STRINGS.en
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
  const edges = (text: string) => [/^\s*/.exec(text)![0], /\s*$/.exec(text)![0]]
  for (const lang of ['ko', 'zh', 'ja', 'es', 'pt', 'fr'] as const) {
    const table = STRINGS[lang]
    assert.notEqual(table, english, lang)
    assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), lang)
    for (const key of Object.keys(english) as Key[]) {
      assert.deepEqual(placeholders(table[key]), placeholders(english[key]), lang + ' ' + key)
      assert.deepEqual(edges(table[key]), edges(english[key]), lang + ' ' + key)
    }
  }
})

test('displayWidth counts terminal cells: wide CJK 2, combining marks 0', () => {
  assert.equal(displayWidth(''), 0)
  assert.equal(displayWidth('Auto ●'), 6)
  assert.equal(displayWidth('추론 강도'), 9)
  assert.equal(displayWidth('推理强度'), 8)
  assert.equal(displayWidth('ｶﾀｶﾅ'), 4)
  assert.equal(displayWidth('ＡＢ'), 4)
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('한̀글'), 4)
  assert.equal(displayWidth('⧗ 41분'), 6)
  assert.equal(displayWidth('𠀋'), 2)
  assert.equal(clip('일반 분야의 고정 규칙', 9), '일반 분…')
  assert.ok(displayWidth(clip('동점 지수 폭을 넘는 긴 문장', 10)) <= 10)
  assert.equal(clip('short', 9), 'short')
})

test('time units are localized with their placeholders', () => {
  assert.equal(t('en', 'units.minutes', { n: 41 }), '41m')
  assert.equal(t('ko', 'units.minutes', { n: 41 }), '41분')
  assert.equal(t('ko', 'units.hours', { n: 2 }), '2시간')
  assert.equal(t('ko', 'units.days', { n: 3 }), '3일')
  assert.equal(t('ja', 'units.minSec', { m: 4, s: '05' }), '4分05秒')
  assert.equal(t('zh', 'units.hourMin', { h: 1, m: '02' }), '1小时02分')
  assert.equal(t('es', 'units.seconds', { n: '2.1' }), '2.1 s')
  assert.equal(t('fr', 'units.minutes', { n: 41 }), '41 min')
  assert.equal(t('fr', 'units.days', { n: 3 }), '3 j')
  assert.equal(t('fr', 'units.hourMin', { h: 1, m: '02' }), '1 h 02 min')
  assert.equal(t('fr', 'units.dayHour', { d: 2, h: 5 }), '2 j 5 h')
  assert.equal(t('fr', 'units.clockHours'), '24')
})

test('French keeps its typography, vocabulary and interpolation', () => {
  const NB = ' '
  assert.equal(t('fr', 'alerts.hotTitle', { window: '5 h', percent: 87 }), `Limite 5 h à 87${NB}%`)
  assert.equal(t('fr', 'band.limitCaption', { window: 'hebdomadaire', save: t('fr', 'band.saveCaption') }), 'limite hebdomadaire · ÉCONOMIE')
  assert.equal(t('fr', 'limits.date', { weekday: 'jeu.', month: 'oct.', day: 30, time: '15:35' }), 'jeu. 30 oct., 15:35')
  assert.equal(t('fr', 'band.modeTip', { name: 'Rapide' }), `Le mode «${NB}Rapide${NB}» est actif${NB}: les workers le suivent. Modifiez-le dans les paramètres rapides.`)
  assert.match(t('fr', 'alerts.coldBody', { minutes: 7, tokens: '120k' }), /7 min d’inactivité, les 120k jetons/)
  assert.equal(t('fr', 'settings.haikuFallback'), 'bascule sur Haiku')
  assert.equal(t('fr', 'agents.fallback', { reason: 'quota' }), `▲ modèle de secours utilisé${NB}: quota`)
  // A model-facing contract keeps its literal tokens whatever the language around it.
  assert.ok(t('fr', 'workers.noReason', { name: 'x' }).includes('"Model reason: rule <fichier> — <la règle>"'))
  for (const [key, text] of Object.entries(STRINGS.fr)) {
    assert.ok(!text.includes("'"), 'straight apostrophe in ' + key)
    assert.ok(!/ [:;?!%]/.test(text), 'breakable space before punctuation in ' + key)
  }
})

test('the mod carries no affiliation line', () => {
  for (const table of Object.values(STRINGS)) assert.ok(!Object.hasOwn(table, 'settings.notAffiliated'))
})

test('t falls back to English then the key, preserves missing variables and substitutes literally', () => {
  const original = STRINGS.ko['band.effortAlt']
  try {
    STRINGS.ko['band.effortAlt'] = '{value}: {value}; {mode}; {why}; {missing}'
    assert.equal(t('ko', 'band.effortAlt', { value: '$& {mode}', mode: 0, why: '' }), '$& {mode}: $& {mode}; 0; ; {missing}')
    delete (STRINGS.ko as Partial<Record<Key, string>>)['band.effortAlt']
    assert.equal(t('ko', 'band.effortAlt', { value: 'High', mode: 'auto', why: '' }), 'Effort High (auto)')
    assert.notEqual(t('ko', 'band.auto'), t('en', 'band.auto'))
    STRINGS.ko['band.effortAlt'] = ''
    assert.equal(t('ko', 'band.effortAlt'), '')
    assert.equal(t('en', 'unknown.key', { value: 'x' }), 'unknown.key')
    assert.equal(t('en', 'constructor'), 'constructor')
    assert.equal(t('en', 'band.effortAlt'), 'Effort {value} ({mode}){why}')
  } finally { STRINGS.ko['band.effortAlt'] = original }
})

test('debug localizes nested labels without changing diagnostic values', () => {
  const value = { pick: { effort: 'high', why: 'model reason' }, lastRequest: { model: 'gpt-6.1-sol', sentEffort: 'high' }, unknown: 'unchanged' }
  for (const lang of ['ko', 'zh', 'ja', 'es', 'pt', 'fr'] as const) {
    const label = (key: Key) => STRINGS[lang][key]
    assert.deepEqual(JSON.parse(debugText(lang, value)), {
      [label('commands.debugPick')]: { [label('commands.debugEffort')]: 'high', [label('commands.debugWhy')]: 'model reason' },
      [label('commands.debugLastRequest')]: { [label('commands.debugModel')]: 'gpt-6.1-sol', [label('commands.debugSentEffort')]: 'high' },
      unknown: 'unchanged',
    }, lang)
  }
  assert.equal(debugText('en', value), JSON.stringify(value, null, 2))
})

test('stats uses the requested language without changing counters or number formatting', () => {
  const original = STRINGS.ko['commands.statsAuto']
  try {
    STRINGS.ko['commands.statsAuto'] = '자동 {prompts}개 · 요청 {requests}개 · {total} 토큰'
    assert.equal(formatStats(emptyStats(), 'ko').split('\n')[0], '자동 0개 · 요청 0개 · 0 토큰')
    assert.ok(formatStats(emptyStats(), 'en').startsWith('Auto: 0 prompts, 0 requests; 0 weighted tokens'))
  } finally { STRINGS.ko['commands.statsAuto'] = original }
})

