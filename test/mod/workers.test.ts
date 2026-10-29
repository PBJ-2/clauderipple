import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS, normalizeSettings } from '../../packages/mod/hooks/settings.ts'
import { rungOf } from '../../packages/mod/hooks/ladder.ts'
import type { Settings, WorkerCandidate, WorkerVerdict } from '../../packages/mod/types/index.d.ts'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { AUTO_DESCRIPTION, modelReason, ruleReason, withoutRouting, userSaid, readMarker, agentProvider, chatgptUsable,
  ladderPick, markerDomain, workerRule, routerModelOptions, zenJev, spawnModel, takesOver, claudeCandidates, allowed } = await import('../../packages/mod/hooks/workers.ts')
const { agentModel, delegationPin, pinAllows, pinSaid, PIN_SAID_MAX, rivalProviders, userNamed } = await import('../../packages/mod/hooks/worker.ts')
const candidates: WorkerCandidate[] = [
  { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'deepseek' },
  { target: { agent: 'gpt-6-1-sol' }, model: 'gpt-6.1-sol', provider: 'chatgpt' },
  { target: { agent: 'gpt-6-astra' }, model: 'gpt-6-astra', provider: 'chatgpt' },
  { target: { agent: 'claude-sonnet-5-5' }, model: 'claude-sonnet-5-5', provider: 'zen' },
]
const verdict: WorkerVerdict = { domain: 'backend', level: 'standard', effort: 'medium', why: 'implementation' }
const pick = (s: Settings = DEFAULTS, v = verdict, workers = candidates, usable = true) => ladderPick(v, s.rules.general, s, workers, usable, 'en', s.allow)

test('ripple:auto asks the session for the tier and domain, and for a model only with its source', () => {
  for (const marker of ['[[ripple: light]]', '[[ripple: standard]]', '[[ripple: hard]]', '[[ripple: max]]', '[[ripple: standard ui]]']) assert.ok(AUTO_DESCRIPTION.includes(marker))
  assert.match(AUTO_DESCRIPTION, /Model reason: user/)
  assert.match(AUTO_DESCRIPTION, /Model reason: rule/)
  assert.match(AUTO_DESCRIPTION, /never carry a model over from an earlier task/)
  assert.doesNotMatch(AUTO_DESCRIPTION, /judge/)
})

test('a model reason names its source and the user\'s quoted words; the worker never reads the routing lines', () => {
  assert.deepEqual(modelReason('[[ripple: gpt-6-astra@high]]\nModel reason: user "아스트라에게 물어봐"\nTask'), { source: 'user', text: '"아스트라에게 물어봐"', quote: '아스트라에게 물어봐' })
  assert.deepEqual(modelReason('model reason: User “use Sol for this”'), { source: 'user', text: '“use Sol for this”', quote: 'use Sol for this' })
  assert.deepEqual(modelReason('Model reason: rule memory/translation-pipeline-scope.md — 번역 초안은 Opus'), { source: 'rule', text: 'memory/translation-pipeline-scope.md — 번역 초안은 Opus' })
  assert.deepEqual(modelReason('Model reason: user'), { source: 'user', text: '' })
  for (const prompt of ['no reason here', 'Model reason: guess "solo"']) assert.equal(modelReason(prompt), null)
  assert.equal(withoutRouting('[[ripple: opus@high]]\nModel reason: user "오푸스로 번역해"\nTranslate the strings.'), 'Translate the strings.')
  assert.equal(withoutRouting('[[ripple: standard ui]]\nFix the sheet.'), 'Fix the sheet.')
})

test('a rule reason needs a concrete file and a non-empty rule; an empty one names nothing', () => {
  for (const text of ['memory/translation-pipeline-scope.md — 번역 초안은 Opus', 'rules/workers.md — UI copy runs on Astra', 'CLAUDE.md - always', 'docs/2026-10-12-worker-tiers.md — tiers', 'C:\\rules\\x.md — windows path', 'x/md: a path']) assert.equal(ruleReason(text), true, text)
  // No file, no rule, or a bare word where the file belongs.
  for (const text of ['', 'CLAUDE.md', 'rules/workers.md —', '— always', 'translation runs on Opus', 'docs file.md', 'CLAUDE.md.']) assert.equal(ruleReason(text), false, text)
})

test('a quote counts only when the user said it, whitespace and case aside, and is not a lone word', () => {
  const words = ['번역은  오푸스로 해줘', 'Then ask Gemini for a review']
  assert.equal(userSaid('번역은 오푸스로', words), true)
  assert.equal(userSaid('ask gemini', words), true)
  assert.equal(userSaid('딥시크로 번역해', words), false)
  assert.equal(userSaid('오푸', words), false)
  assert.equal(userSaid('   ', words), false)
})

test('markers and frontmatter provider retain existing parsing semantics', () => {
  assert.deepEqual(readMarker('context\n[[ ripple : GPT-6.1-SOL @ HIGH ]]'), { name: 'gpt-6.1-sol', level: 'high' })
  assert.equal(agentProvider('---\ndescription: Executor via chatgpt.\n---\n'), 'chatgpt')
  assert.equal(agentProvider('description: via chatgpt.'), undefined)
})
test('account readiness and all windows decide availability; unknown is not exhaustion', () => {
  const status = (accounts: unknown[]) => ({ chatgpt: { accounts: { chatgpt: accounts } } })
  const ready = { state: 'ready', paused: false, needsReauth: false }
  assert.equal(chatgptUsable(status([ready])), true)
  assert.equal(chatgptUsable(status([])), false)
  for (const account of [{ ...ready, paused: true }, { ...ready, needsReauth: true }, { ...ready, quota: { rate_limits: { secondary: { used_percent: 100 } } } }]) assert.equal(chatgptUsable(status([account])), false)
  assert.equal(chatgptUsable({}), true)
})
test('router catalogue includes every declared model, including Anthropic and nongenerated Jev', () => {
  const config = { providers: { anthropic: { models: [{ id: 'claude-sonnet-5-5' }] }, 'opencode-zen': { models: [{ id: 'jev-1.13' }, { id: 'un-generated' }], headers: { authorization: 'Bearer exact' } } } }
  assert.deepEqual(routerModelOptions(config).map(m => m.label), ['claude-sonnet-5-5 · anthropic', 'jev-1.13 · opencode-zen', 'un-generated · opencode-zen'])
  assert.deepEqual(zenJev(config), { authorization: 'Bearer exact', model: 'jev-1.13' })
  assert.deepEqual(zenJev({}), { model: 'jev-latest' })
})
test('every field uses the general ladder and a missing level climbs', () => {
  assert.equal(pick().target?.agent, 'gpt-6-1-sol')
  assert.equal(pick(DEFAULTS, { ...verdict, domain: 'design', level: 'deep' }).target?.agent, 'gpt-6-astra')
  assert.equal(pick(DEFAULTS, { ...verdict, level: 'light' }, candidates.slice(1)).target?.agent, 'gpt-6-1-sol')
})
test('domain ladders select UI for design/frontend, backend separately, otherwise this set\'s general', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { standard: { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' } } },
    backend: { mode: 'ladder', rungs: { standard: { target: { agent: 'gpt-6-astra' }, effort: 'high' } } },
  } })
  for (const domain of ['design', 'frontend', 'backend', 'general', 'docs', 'research', 'ops'] as const) {
    const { rule, ladder } = workerRule(domain, s)
    const expected = domain === 'design' || domain === 'frontend' ? 'ui' : domain === 'backend' ? 'backend' : 'general'
    assert.equal(rule, expected)
    assert.equal(ladder, expected === 'general' ? s.rules.general : s.domainRules![expected])
    const resolved = ladderPick({ ...verdict, domain }, ladder, s, candidates, true, 'en')
    assert.equal(resolved.target?.agent, expected === 'ui' ? 'deepseek-v4-1-flash' : expected === 'backend' ? 'gpt-6-astra' : 'gpt-6-1-sol')
  }
  assert.deepEqual(workerRule('backend', { ...s, domainRules: { ui: s.domainRules!.ui } }), { rule: 'general', ladder: s.rules.general })
  // Unavailable domain rungs climb only within that ladder, not into the general one, nor onto the
  // session's own model.
  const blocked = ladderPick(verdict, s.domainRules!.backend!, s, candidates, false, 'en')
  assert.equal(blocked.target, undefined)
})

test('under a domain ladder light and ordinary work take the light row; hard work and plans the heavy one', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'low' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] } },
  } })
  for (const domain of ['design', 'frontend'] as const) {
    const at = (change: Partial<WorkerVerdict>) => ladderPick({ ...verdict, domain, ...change }, s.domainRules!.ui!, s, candidates, true, 'en').target?.agent
    for (const change of [{ level: 'light' }, { level: 'standard' }] as const) assert.equal(at(change), 'deepseek-v4-1-flash')
    for (const change of [{ level: 'deep' }, { level: 'deep', kind: 'plan' }] as const) assert.equal(at(change), 'gpt-6-astra')
  }
})

test('a tier marker\'s domain word picks the ladder; no word is general', () => {
  assert.deepEqual(readMarker('[[ripple: standard ui]]\nWork.'), { name: 'standard', domain: 'ui' })
  assert.deepEqual(readMarker('[[ripple: hard  backend ]]\nWork.'), { name: 'hard', domain: 'backend' })
  assert.deepEqual(readMarker('[[ripple: gemini-3-8-flash@high]]'), { name: 'gemini-3-8-flash', level: 'high' })
  for (const [word, domain] of [['ui', 'frontend'], ['frontend', 'frontend'], ['design', 'design'], ['backend', 'backend'], ['server', 'backend'], [undefined, 'general'], ['docs', 'general']] as const) {
    assert.equal(markerDomain(word), domain)
    assert.equal(workerRule(markerDomain(word), normalizeSettings({ domainRules: { ui: DEFAULTS.rules.general, backend: DEFAULTS.rules.general } })).rule, domain === 'frontend' || domain === 'design' ? 'ui' : domain)
  }
})

test('a model counts as named only when the user said it lately, in English or Korean', () => {
  const user = (text: string) => ({ role: 'user' as const, text })
  const said = (...texts: string[]) => texts.map(user)
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이한테 교정안 받아 와')), true)
  assert.equal(userNamed('gemini-3-8-flash', said('ask Gemini for a review')), true)
  assert.equal(userNamed('gpt-6-1-sol', said('솔한테 맡겨')), true)
  // A delegating verb written straight onto the name still names it; "솔직히" still does not.
  for (const text of ['아니 오푸스시켜 중요한거잖아', '오푸스써', '오퍼스 돌려']) assert.equal(userNamed('opus', said(text)), true, text)
  for (const text of ['솔시켜', '솔맡겨']) assert.equal(userNamed('gpt-6-1-sol', said(text)), true, text)
  assert.equal(userNamed('gpt-6-1-sol', said('솔직히 별로야')), false)
  assert.equal(userNamed('gpt-6-1-sol', said('솔직히 이건 어려운 일이야')), false, 'a word that only starts with the name')
  assert.equal(userNamed('gpt-6-1-sol', said('GPT로 돌려')), true)
  assert.equal(userNamed('sonnet', said('소넷이 낫겠다')), true)
  assert.equal(userNamed('claude-opus-5-5', said('오푸스로 해')), true)
  assert.equal(userNamed('deepseek-v4.1-flash', said('flash 모델로')), false, 'a generic word names nothing')
  // Only the last two messages from the user: an older request does not cover later work.
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이한테 시켜', '반영해', '이제 서버 고쳐')), false)
  // Tool results, notices and summaries are not the user.
  assert.equal(userNamed('gemini-3-8-flash', [user('일 해'), { role: 'user', text: 'gemini output', toolResults: [{}] }, user('<task-notification>gemini done</task-notification>')]), false)
  assert.equal(userNamed('gemini-3-8-flash', said('일 해', '<local-command-stdout>gemini</local-command-stdout>', 'This session is being continued … gemini')), false)
  // A reply the app quotes is the user's: it opens on an HTML comment, not a tag.
  assert.equal(userNamed('gemini-3-8-flash', said('<!-- reply 1 -->\n> 어느 모델로 할까요?\n\n제미나이로 해')), true)
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이로 해', '<!-- reply 1 -->\n> 진행할까요?\n\n아니 그건 됐고 다른 거 해')), true, 'the quoted reply is one of the last two, the earlier message still counts')
  // A prompt typed while a turn ran is absorbed into that turn and never a user message: the prompts
  // as submitted are heard too (2026-10-23: "솔한테 돌려" mid-turn went by tier).
  assert.equal(userNamed('gpt-6-1-sol', said('에이전트 창이 비어', '버그 고쳐'), ['솔한테 버그탐지 돌려']), true)
  assert.equal(userNamed('gpt-6-1-sol', said('에이전트 창이 비어'), ['이것도 고쳐']), false)
  // A short "go" approves the answer it replies to.
  const proposal = [user('정리해'), { role: 'assistant' as const, text: '제미나이에게 맡기겠습니다. 진행할까요?' }, user('ㄱㄱ')]
  assert.equal(userNamed('gemini-3-8-flash', proposal), true)
  assert.equal(userNamed('gemini-3-8-flash', [...proposal.slice(0, 2), user('아니 다른 걸로 해 줘 이번엔')]), false)
})

test('Korean Argon and provider names preserve an explicit worker without authorizing its other provider', () => {
  const providers = ['google-gemini', 'opencode-go', 'chatgpt']
  const named = (model: string, provider: string, text: string, prompts: string[] = []) => userNamed(model, [{ role: 'user', text }], prompts, { provider, providers })
  for (const model of ['gemini-4-argon', 'gemini-4-argon-contributor']) {
    assert.equal(named(model, model.endsWith('contributor') ? 'opencode-go' : 'google-gemini', '아르곤한테 맡겨'), true)
  }
  for (const text of ['아르곤 api 지금 한도 꽉 차서 안될걸? 오픈코드쪽으로 써', '아르곤 API 대신 오픈코드', 'use OpenCode for Argon']) {
    assert.equal(named('gemini-4-argon-contributor', 'opencode-go', text), true, text)
    assert.equal(named('gemini-4-argon', 'google-gemini', text), false, text)
  }
  for (const text of ['구글로 아르곤 돌려', 'google-gemini로 아르곤 돌려']) {
    assert.equal(named('gemini-4-argon', 'google-gemini', text), true, text)
    assert.equal(named('gemini-4-argon-contributor', 'opencode-go', text), false, text)
  }
  assert.equal(named('gemini-4-argon-contributor', 'opencode-go', '아르곤으로 버그 고쳐', ['오픈코드쪽으로 써']), true)
  for (const text of ['opencode-go로 해', '오픈코드로 해', 'google-gemini로 해', '버그 고쳐']) {
    assert.equal(named('gemini-4-argon-contributor', 'opencode-go', text, ['오픈코드쪽으로 써']), false, text)
  }
  assert.equal(named('gemini-4-argon', 'google-gemini', '버그 고쳐', ['오픈코드쪽으로 써']), false)
  assert.equal(named('gemini-4-argon', 'google-gemini', '아르곤처럼 생겼네'), false)
  assert.equal(named('gemini-4-argon-contributor', 'opencode-go', 'opencoded example'), false)
  assert.equal(userNamed('gemini-4-argon-contributor', [{ role: 'user', text: '<task-notification>오픈코드</task-notification>' }], [], { provider: 'opencode-go', providers }), false)
})

test('a model name shared with a provider is not a source restriction on other explicitly named models', () => {
  const source = { provider: 'chatgpt', providers: ['chatgpt', 'deepseek', 'google-gemini', 'opencode-go'] }
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: 'Use Sol, Astra or DeepSeek for this.' }], [], source), true)
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '솔과 제미나이에게 각각 검토시켜' }], [], source), true)
  for (const provider of ['google-gemini', 'opencode-go']) {
    assert.equal(userNamed('gemini-4-argon', [{ role: 'user', text: '제미나이로 해' }], [], { ...source, provider }), true)
  }
})

test('only a rival source is chosen by naming a provider, and only in the user\'s own words', () => {
  const sources = [
    { model: 'gemini-4-argon', provider: 'google-gemini' }, { model: 'gemini-4-argon-contributor', provider: 'opencode-go' },
    { model: 'gpt-6.1-sol', provider: 'chatgpt' }, { model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
  ]
  assert.deepEqual(rivalProviders('gemini-4-argon', sources).sort(), ['google-gemini', 'opencode-go'])
  assert.deepEqual(rivalProviders('gpt-6.1-sol', sources), ['chatgpt'])
  // Naming OpenCode for DeepSeek says nothing about which source runs Sol.
  const sol = { provider: 'chatgpt', providers: rivalProviders('gpt-6.1-sol', sources) }
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '솔은 구현, 딥시크는 오픈코드로' }], [], sol), true)
  // The answer a short "go" replies to mentions a provider in passing; that is not the user's choice.
  const argon = { provider: 'google-gemini', providers: rivalProviders('gemini-4-argon', sources) }
  const answer = [{ role: 'user' as const, text: '아르곤으로 해' }, { role: 'assistant' as const, text: 'OpenCode 쪽 한도도 확인했습니다. 아르곤으로 진행할까요?' }, { role: 'user' as const, text: 'ㄱㄱ' }]
  assert.equal(userNamed('gemini-4-argon', answer, [], argon), true)
})

test('session pin requires a standing instruction, not a one-off choice', () => {
  const pin = (text: string) => delegationPin({ role: 'user', text }, candidates)
  for (const text of ['이거 솔 시켜', '솔로 해', '솔직히 앞으로 잘해', '앞으로 GPT로 해', '앞으로 솔과 딥시크로 해', '솔로 고정하지 마', "don't pin Sol for this session"]) assert.equal(pin(text), undefined, text)
  // Everyday words are not a standing instruction: a complaint, a pinned header, a standing "don't".
  for (const text of ['솔이 계속 실패하네', '계속 솔한테 시켜', '헤더 고정해 줘, 솔한테 시켜', '앞으로 솔은 쓰지 마', '앞으로 솔 말고 오푸스로', 'stop using Sol from now on']) assert.equal(pin(text), undefined, text)
  for (const text of ['앞으로 솔로 해', '이제부터 솔로 해', '이 세션은 솔로', '이번 세션 내내 솔로', '솔로 고정', '위임 고정 솔', 'from now on use Sol', 'use gpt-6.1-sol for this session']) {
    assert.deepEqual(pin(text), { model: 'gpt-6.1-sol', provider: 'chatgpt' }, text)
  }
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '솔로 해' }]), true)
})

test('session pin replaces, releases and authorizes only its model and source', () => {
  let current = delegationPin({ role: 'user', text: '앞으로 솔로' }, candidates) ?? null
  assert.equal(pinAllows(current, 'gpt-6-1-sol@high', 'chatgpt'), true)
  assert.equal(pinAllows(current, 'gpt-6-astra', 'chatgpt'), false)
  assert.equal(pinAllows(current, 'gpt-6.1-sol', 'other'), false)
  current = delegationPin({ role: 'user', text: '이제부터 딥시크로 고정' }, candidates) ?? null
  assert.equal(pinAllows(current, 'deepseek-v4.1-flash@low', 'deepseek'), true)
  assert.equal(pinAllows(current, 'gpt-6.1-sol', 'chatgpt'), false)
  for (const text of ['고정 풀어', '고정을 풀어', '고정 해제', '고정해제', '모델은 알아서 해', '모델은 알아서 골라', '위임 모델은 자동으로 골라', 'unpin', 'choose the model automatically']) assert.equal(delegationPin({ role: 'user', text }, []), null, text)
  // Words about something else keep the pin.
  for (const text of ['너가 알아서 판단해서 해', '자동으로 재시작되게 해']) assert.equal(delegationPin({ role: 'user', text }, []), undefined, text)
  assert.equal(pinAllows(null, 'gpt-6.1-sol', 'chatgpt'), false)
})

test('standing choices bind a model name to delegation, including colloquial Korean', () => {
  const sources = [...candidates, { model: 'opus', provider: 'anthropic' }]
  const examples: [string, string, string][] = [
    ['앞으로 솔로 해', 'gpt-6.1-sol', 'chatgpt'],
    ['이제부터 오푸스한테 시켜', 'opus', 'anthropic'],
    ['이 세션은 딥시크로 돌려', 'deepseek-v4.1-flash', 'deepseek'],
    ['솔로 고정', 'gpt-6.1-sol', 'chatgpt'],
    ['솔로고정해 줘', 'gpt-6.1-sol', 'chatgpt'],
    ['앞으로 솔에게 맡겨 주세요', 'gpt-6.1-sol', 'chatgpt'],
    ['앞으로 오푸스 써', 'opus', 'anthropic'],
    ['앞으로 딥시크를 써 주세요', 'deepseek-v4.1-flash', 'deepseek'],
    ['이제부터 솔한테 검토시켜', 'gpt-6.1-sol', 'chatgpt'],
    ['앞으로 솔로 작업을 돌려 주세요', 'gpt-6.1-sol', 'chatgpt'],
    ['위임 고정: 솔', 'gpt-6.1-sol', 'chatgpt'],
    ['from now on delegate work to Sol', 'gpt-6.1-sol', 'chatgpt'],
  ]
  for (const [text, model, provider] of examples) assert.deepEqual(delegationPin({ role: 'user', text }, sources), { model, provider }, text)
})

test('unrelated standing phrases, logs and automatic choices leave an existing pin unchanged', () => {
  const sources = [...candidates, { model: 'opus', provider: 'anthropic' }]
  for (const text of [
    '앞으로 오푸스 오류 로그만 보여 주세요', '앞으로 오푸스 오류 로그만 보여 줘',
    '앞으로 솔 로그를 보여 줘', '이 세션은 딥시크 오류만 출력해',
    '이제부터 오푸스한테 발생한 오류 로그만 보여 줘', '앞으로 솔로 작성한 로그를 보여 줘',
    '솔이 계속 실패하네', '알아서 판단해서 해', '테스트 데이터는 알아서 골라',
    '테스트 데이터는 알아서 골라 주세요', '테스트 데이터는 자동으로 골라',
    '알아서 골라', '자동으로 골라', 'choose automatically', 'choose test data automatically',
    '헤더 고정 풀어', '테스트 모델은 알아서 골라', '모델 오류 로그는 알아서 골라',
    '고정하지 마', '모델은 알아서 고르지 마', '위임 고정은 해제하지 마',
    '앞으로 로그만 보여 줘. 이번에는 솔로 해', '앞으로 로그만 보여 줘, 솔 시켜',
    '헤더 고정해 줘. 솔로 해', '앞으로 솔로 고정된 헤더만 보여 줘',
    '솔로 고정한 문장을 보여 줘', 'from now on show Sol error logs',
    'from now on use Sol error logs', "from now on use Sol's logs",
  ]) assert.equal(delegationPin({ role: 'user', text }, sources), undefined, text)
})

test('release phrases name delegation, model selection or the pin itself', () => {
  for (const text of [
    '고정 풀어 줘', '고정을 풀어 주세요', '위임 고정 풀어', '위임 고정을 해제해 주세요',
    '모델 고정 해제', '모델은 알아서 골라 줘', '모델을 자동으로 골라 주세요',
    '위임은 알아서 해', '위임 모델은 알아서 정해', '모델 선택은 자동으로 해',
    'unpin the model', 'choose the worker automatically',
  ]) assert.equal(delegationPin({ role: 'user', text }, []), null, text)
})

test('an exact normalized full id beats family matches, which otherwise select the latest version', () => {
  const sources = [
    { model: 'gpt-6-sol@high', provider: 'chatgpt' },
    { model: 'gpt-6.1-sol', provider: 'chatgpt' },
    { model: 'gpt-6.1-sol@medium', provider: 'chatgpt' },
  ]
  for (const text of ['앞으로 gpt-6.1-sol로 위임 고정', '앞으로 GPT-6-1-SOL로 해', 'use gpt-6.1-sol for this session']) {
    assert.deepEqual(delegationPin({ role: 'user', text }, sources), { model: 'gpt-6.1-sol', provider: 'chatgpt' }, text)
    const pin = delegationPin({ role: 'user', text }, sources)!
    assert.equal(pinAllows(pin, 'gpt-6-sol', 'chatgpt'), false)
  }
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 gpt-6-sol로 해' }, sources), { model: 'gpt-6-sol', provider: 'chatgpt' })
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 솔로 해' }, sources), { model: 'gpt-6.1-sol', provider: 'chatgpt' })
  for (const text of ['앞으로 gpt-6.1-sol-extra로 해', '앞으로 gpt-6.1-sol2로 해']) {
    assert.equal(delegationPin({ role: 'user', text }, sources), undefined, text)
  }
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 솔로 해' }, sources.slice(1)), { model: 'gpt-6.1-sol', provider: 'chatgpt' })
})

test('real default worker files plus the router catalogue pin Sol, Opus and DeepSeek by family', () => {
  const files = new Map([
    ['gpt-6-1-sol', '---\nmodel: gpt-6.1-sol@high\ndescription: Worker via chatgpt.\n---\n'],
    ['deepseek-v4-1-flash', '---\nmodel: deepseek-v4.1-flash@high\ndescription: Worker via deepseek.\n---\n'],
  ])
  const workers = [...files.values()].map(file => ({ model: agentModel(file)!, provider: agentProvider(file)! }))
  const catalogue = routerModelOptions({ providers: {
    chatgpt: { models: [{ id: 'gpt-6-sol' }, { id: 'gpt-6.1-sol' }] },
    anthropic: { models: [{ id: 'claude-opus-5-4' }, { id: 'claude-opus-5-5' }] },
    deepseek: { models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4.1-flash' }] },
  } }).map(model => ({ model: model.value, provider: model.provider }))
  const sources = workers.concat(claudeCandidates(), catalogue)
  const examples: [string, string, string][] = [
    ['앞으로 솔로 해', 'gpt-6.1-sol', 'chatgpt'],
    ['앞으로 오푸스로 해', 'claude-opus-5-5', 'anthropic'],
    ['이 세션은 딥시크로 돌려', 'deepseek-v4.1-flash', 'deepseek'],
  ]
  for (const list of [sources, sources.toReversed()]) {
    for (const [text, model, provider] of examples) assert.deepEqual(delegationPin({ role: 'user', text }, list, workers), { model, provider }, text)
  }
})

test('one generated family worker outranks newer catalogue versions, but never an exact requested id', () => {
  const worker = { model: 'gpt-6-sol@high', provider: 'chatgpt' }
  const sources = [worker, { model: 'gpt-6-sol', provider: 'chatgpt' }, { model: 'gpt-6.1-sol', provider: 'chatgpt' }]
  const workers = [worker, { ...worker, model: 'gpt-6-sol@medium' }]
  for (const list of [sources, sources.toReversed()]) {
    assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 솔로 해' }, list, workers), { model: 'gpt-6-sol', provider: 'chatgpt' })
    assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 GPT-6-1-SOL로 고정' }, list, workers), { model: 'gpt-6.1-sol', provider: 'chatgpt' })
  }
})

test('without one generated worker, the family latest compares numeric version components', () => {
  for (const [text, older, newer, provider] of [
    ['앞으로 솔로 해', 'gpt-6-sol', 'gpt-6.1-sol', 'chatgpt'],
    ['앞으로 솔로 해', 'gpt-6.9-sol', 'gpt-6.10-sol', 'chatgpt'],
    ['앞으로 솔로 해', 'gpt-6.99-sol', 'gpt-7-sol', 'chatgpt'],
    ['앞으로 오푸스로 해', 'claude-opus-5-9', 'claude-opus-5-10', 'anthropic'],
    ['이 세션은 딥시크로 돌려', 'deepseek-v4.9-flash', 'deepseek-v4.10-flash', 'deepseek'],
  ]) {
    const sources = [{ model: older!, provider: provider! }, { model: newer!, provider: provider! }]
    for (const list of [sources, sources.toReversed()]) {
      for (const workers of [[], sources]) assert.deepEqual(delegationPin({ role: 'user', text: text! }, list, workers), { model: newer, provider }, text)
    }
  }
})

test('latest cannot choose across families or break equal-version variant ties', () => {
  const variants = [
    { model: 'deepseek-v4.1-flash', provider: 'deepseek' },
    { model: 'deepseek-v4.1-pro', provider: 'deepseek' },
  ]
  for (const workers of [[], variants]) assert.equal(delegationPin({ role: 'user', text: '앞으로 딥시크로 해' }, variants, workers), undefined)
  assert.equal(delegationPin({ role: 'user', text: '앞으로 GPT로 해' }, [
    { model: 'gpt-6.1-sol', provider: 'chatgpt' }, { model: 'gpt-6-astra', provider: 'chatgpt' },
  ]), undefined)
  assert.equal(delegationPin({ role: 'user', text: '앞으로 솔과 딥시크로 해' }, [...variants, { model: 'gpt-6.1-sol', provider: 'chatgpt' }], [variants[0]!]), undefined)
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 deepseek-v4.1-pro로 해' }, variants, [variants[0]!]), { model: 'deepseek-v4.1-pro', provider: 'deepseek' })
})

test('generated preference keeps provider restrictions and deduplicates normalized ids', () => {
  const sources = [
    { model: 'gpt-6.1-sol@high', provider: 'chatgpt' },
    { model: 'gpt-6-1-sol', provider: 'chatgpt' },
    { model: 'gpt-6.1-sol', provider: 'opencode-go' },
  ]
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 솔로 해' }, sources, sources.slice(0, 2)), { model: 'gpt-6.1-sol', provider: 'chatgpt' })
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 솔을 오픈코드로 위임 고정' }, sources, sources.slice(0, 2)), { model: 'gpt-6.1-sol', provider: 'opencode-go' })
})

test('provider names restrict only a model that was actually named, in messages or submitted prompts', () => {
  const sources = [
    { model: 'gemini-4-argon', provider: 'google-gemini' },
    { model: 'gemini-4-argon-contributor', provider: 'opencode-go' },
    { model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
  ]
  for (const text of ['아르곤을 오픈코드로 검토시켜 주세요', 'use OpenCode for Argon']) {
    for (const prompts of [[], [text]]) {
      const messages = [{ role: 'user' as const, text: prompts.length ? '검토해 주세요' : text }]
      for (const source of sources) assert.equal(userNamed(source.model, messages, prompts, { ...source, providers: rivalProviders(source.model, sources) }), source.model.endsWith('contributor'), source.model + ': ' + text)
    }
  }
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 아르곤을 오픈코드로 위임 고정' }, sources), { model: 'gemini-4-argon-contributor', provider: 'opencode-go' })
  assert.equal(delegationPin({ role: 'user', text: '앞으로 오픈코드로 위임 고정' }, sources), undefined)
})

test('the sentence shown beside a pin is the one that pinned, whitespace folded and cut short', () => {
  assert.equal(pinSaid('앞으로 솔로 해'), '앞으로 솔로 해')
  assert.equal(pinSaid('앞으로 오푸스 오류 로그만 보여 줘.\n이제부터 솔로 해', 'gpt-6.1-sol'), '이제부터 솔로 해')
  assert.equal(pinSaid('먼저 이 파일을 읽어 줘.\n앞으로  솔로   해. 그리고 테스트도 돌려'), '앞으로 솔로 해.')
  const long = pinSaid('이 세션은 ' + '아주 길게 '.repeat(40) + '솔로 해')!
  assert.equal([...long].length, PIN_SAID_MAX)
  assert.ok(long.endsWith('…'))
  assert.equal(pinSaid('   '), undefined)
})

test('session pin ignores assistant, tools, notices, summaries and reminder contents', () => {
  for (const message of [
    { role: 'assistant' as const, text: '앞으로 솔로 고정' },
    { role: 'user' as const, text: '앞으로 솔로 고정', toolResults: [{}] },
    { role: 'user' as const, text: '<task-notification>앞으로 솔로 고정</task-notification>' },
    { role: 'user' as const, text: 'This session is being continued 앞으로 솔로 고정' },
    { role: 'user' as const, text: '<system-reminder>앞으로 솔로 고정</system-reminder>구현해' },
    { role: 'user' as const, text: '<system-reminder>솔</system-reminder>앞으로 해' },
  ]) assert.equal(delegationPin(message, candidates), undefined)
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '<system-reminder>Sol</system-reminder>계속 해' }]), false)
})

test('quota/off never chooses the blocked provider: the ladder moves up, then nothing runs', () => {
  // Standard (Sol) and the rung above (Astra) are both ChatGPT: out of quota, nothing is left.
  const out = pick(DEFAULTS, verdict, candidates, false)
  assert.equal(out.target, undefined)
  assert.equal(out.effort, 'medium')
  assert.match(out.fallbackReason ?? '', /ChatGPT/)
  // Light (DeepSeek) switched off moves up to Standard, never down.
  const off = normalizeSettings({ providers: { deepseek: false } })
  const up = pick(off, { ...verdict, level: 'light' })
  assert.equal(up.target?.agent, 'gpt-6-1-sol')
  assert.equal(up.rung, 'standard')
  assert.equal(up.effort, 'medium')
  assert.match(up.fallbackReason ?? '', /deepseek is switched off/)
  // A model of a switched-off provider named on Claude's own agent does not run either.
  const pinnedModel = normalizeSettings({ ...DEFAULTS, providers: { chatgpt: false }, rules: { general: { mode: 'ladder', rungs: { standard: { target: { agent: 'general-purpose', model: 'gpt-6.1-sol' }, effort: 'medium' } } } } })
  assert.equal(pick(pinnedModel).target, undefined)
})

test('duplicate Gemini workers keep their own provider and skip only the exhausted source', async () => {
  const { ladderOptionsFrom, candidateUsable } = await import('../../packages/mod/hooks/workers.ts')
  const id = 'gemini-4-argon'
  const providers = { 'google-gemini': { usable: false, reason: 'quota_exhausted' }, 'opencode-go': { usable: true } }
  const settings = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { standard: [
    { target: { agent: id }, effort: 'high' }, { target: { agent: id + '-opencode-go' }, effort: 'high' },
  ] } } } })
  const workers: WorkerCandidate[] = [
    { target: { agent: id }, model: 'google-gemini:' + id, provider: 'google-gemini' },
    { target: { agent: id + '-opencode-go' }, model: 'opencode-go:' + id, provider: 'opencode-go' },
  ]
  const result = ladderPick(verdict, settings.rules.general, settings, workers, true, 'en', [], providers)
  assert.deepEqual(result.target, { agent: id + '-opencode-go' })
  assert.equal(result.position, 2)
  assert.equal(result.skipped?.length, 1)
  const out = { 'google-gemini': { usable: true, models: { [id]: { reason: 'quota_exhausted' } } }, 'opencode-go': { usable: true } }
  assert.equal(candidateUsable(workers[0]!, settings, true, out), false)
  assert.equal(candidateUsable(workers[1]!, settings, true, out), true)
  assert.equal(spawnModel(result.target!, 'high', 'opencode-go:' + id + '@medium'), 'opencode-go:' + id + '@high')
  const catalogue = routerModelOptions({ providers: { 'google-gemini': { models: [{ id }] }, 'opencode-go': { models: [{ id }] } } })
  assert.deepEqual(catalogue.map(m => [m.value, m.provider]), [['google-gemini:' + id, 'google-gemini'], ['opencode-go:' + id, 'opencode-go']])
  const options = ladderOptionsFrom({ providers: Object.entries(providers).map(([name, state]) => ({ name, ...state })), agents: workers.map(w => ({ name: w.target.agent, model: id, provider: w.provider, efforts: ['high'] })) }, 0)
  assert.equal(options.choices.find(c => c.target.agent === id + '-opencode-go')?.provider, 'opencode-go')
  assert.equal(options.choices.some(c => c.target.agent === id), false)
  assert.deepEqual(readMarker('[[ripple: opencode-go:gemini-4-argon@high]]'), { name: 'opencode-go:gemini-4-argon', level: 'high' })
  const sources = workers.map(w => ({ model: w.model, provider: w.provider }))
  for (const source of sources) {
    const rivals = rivalProviders(source.model, sources)
    assert.deepEqual(rivals, ['google-gemini', 'opencode-go'])
    assert.equal(userNamed(source.model, [{ role: 'user', text: '오픈코드로 해' }], [], { ...source, providers: rivals }), false)
    assert.equal(userNamed(source.model, [{ role: 'user', text: '아르곤을 오픈코드로 돌려' }], [], { ...source, providers: rivals }), source.provider === 'opencode-go')
  }
  assert.deepEqual(delegationPin({ role: 'user', text: '앞으로 아르곤을 오픈코드로 위임 고정' }, sources, sources), { model: 'opencode-go:' + id, provider: 'opencode-go' })
})

test('spawn suffix and takeover retain named-worker and fork boundaries', () => {
  assert.equal(spawnModel({ agent: 'sol' }, 'max', 'gpt-6.1-sol@medium'), 'gpt-6.1-sol@max')
  assert.equal(spawnModel({ agent: 'general-purpose', model: 'sonnet' }, 'high'), 'claude-sonnet-5-5')
  assert.equal(takesOver({ subagentType: 'ripple:auto', fork: false }, DEFAULTS), true)
  assert.equal(takesOver({ subagentType: 'ripple:auto', fork: true }, DEFAULTS), false)
  // The tier agents are gone (2026-10-12): a stale session's ripple:low runs as Claude Code spawns it.
  assert.equal(takesOver({ subagentType: 'ripple:low', fork: false }, DEFAULTS), false)
  assert.equal(takesOver({ subagentType: 'general-purpose', fork: false }, { ...DEFAULTS, agentAuto: 'all' }), true)
  assert.equal(takesOver({ subagentType: 'general-purpose', model: 'sonnet', fork: false }, { ...DEFAULTS, agentAuto: 'all' }), true)
  for (const subagentType of ['gpt-6-1-sol', 'opus-xhigh', 'custom-worker']) {
    assert.equal(takesOver({ subagentType, fork: false }, { ...DEFAULTS, agentAuto: 'all' }), true)
    assert.equal(takesOver({ subagentType, fork: false }, { ...DEFAULTS, agentAuto: 'auto' }), false)
    assert.equal(takesOver({ subagentType, fork: true }, { ...DEFAULTS, agentAuto: 'all' }), false)
  }
  for (const subagentType of ['Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'plugin:worker']) assert.equal(takesOver({ subagentType, fork: false }, { ...DEFAULTS, agentAuto: 'all' }), false)
})

test('spawn models resolve every native family from the worker table without changing explicit selections', () => {
  for (const candidate of claudeCandidates()) {
    assert.equal(spawnModel(candidate.target, 'high'), candidate.model)
    assert.equal(spawnModel({ agent: 'native' }, 'max', candidate.target.model), `${candidate.model}@max`)
  }
  for (const model of [undefined, 'inherit', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gpt-6.1-sol@high', 'custom', 'sonnet-custom']) {
    assert.equal(spawnModel({ agent: 'general-purpose', ...(model ? { model } : {}) }, 'low'), model)
  }
  assert.equal(spawnModel({ agent: 'general-purpose', model: 'opus@high' }, 'low'), 'claude-opus-5-5@high')
  for (const [model, expected] of [['opus[1m]', 'claude-opus-5-5[1m]'], ['sonnet[1m]@high', 'claude-sonnet-5-5[1m]@high'], ['claude-opus-4-6[1m]@high', 'claude-opus-4-6[1m]@high']]) {
    assert.equal(spawnModel({ agent: 'general-purpose', model }, 'low'), expected)
  }
})

test('allow-lists pick by worker agent, so one model from two providers is told apart; provider names still match', () => {
  const twins: WorkerCandidate[] = [
    { target: { agent: 'deepseek-flash' }, model: 'deepseek-v4.1-flash', provider: 'deepseek' },
    { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
    ...candidates.slice(1),
  ]
  assert.equal(allowed(twins[1]!, ['opencode-go']), true)
  assert.equal(allowed(twins[0]!, ['opencode-go']), false)
  assert.equal(allowed(twins[0]!, []), true)
  // Claude's own models are ticked as general-purpose:<model>.
  assert.equal(allowed(claudeCandidates()[1]!, ['general-purpose:sonnet']), true)
  assert.equal(allowed(claudeCandidates()[1]!, ['gpt-6-1-sol']), false)
})

test('the ticked models bound the ladder: an unticked rung model falls to the next rung up, and the quick-settings choices list only the ticked', async () => {
  const { ladderOptionsFrom } = await import('../../packages/mod/hooks/workers.ts')
  // Sol is not ticked: Standard (Sol) moves up to Hard (Astra) and says so.
  const ticked = { ...DEFAULTS, allow: ['gpt-6-astra', 'general-purpose:opus', 'deepseek-v4-1-flash'] }
  const result = pick(ticked)
  assert.deepEqual([result.target?.agent, result.rung], ['gpt-6-astra', 'hard'])
  assert.match(result.fallbackReason ?? '', /not a candidate/)
  const raw = { providers: [{ name: 'chatgpt', usable: true }, { name: 'deepseek', usable: true }], agents: [
    { name: 'gpt-6-1-sol', model: 'gpt-6.1-sol', provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'high'] },
    { name: 'gpt-6-astra', model: 'gpt-6-astra', provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'high'] },
  ], claudeEfforts: ['low', 'high'] }
  assert.deepEqual(ladderOptionsFrom(raw, 0).choices.map(c => c.target.agent + (c.target.model ? ':' + c.target.model : '')), ['gpt-6-1-sol', 'gpt-6-astra', 'general-purpose:haiku', 'general-purpose:sonnet', 'general-purpose:opus', 'general-purpose:fable'])
  assert.deepEqual(ladderOptionsFrom(raw, 0, ['gpt-6-astra', 'general-purpose:opus']).choices.map(c => c.target.agent + (c.target.model ? ':' + c.target.model : '')), ['gpt-6-astra', 'general-purpose:opus'])
  assert.equal(Object.hasOwn(ladderOptionsFrom(raw, 0), 'presets'), false)
})
