// The log row's account name is the limits pane's shortening: an email's local part, the owner's
// own label as it is, and nothing for the generic placeholder names the router gives unnamed
// accounts. These are the shapes `/api/requests` actually sends as `accountLabel`.
// Follows test/mod/log-rate.test.ts for extensionless imports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { limitAccountLabel } = await import('../../packages/mod/hooks/ui/view.ts')

test('a log row names an account by the local part of its email', () => {
  assert.equal(limitAccountLabel('work@example.com'), 'work')
  assert.equal(limitAccountLabel('first@example.test'), 'first')
})

test('a log row keeps the name its owner set, and cuts a long one', () => {
  assert.equal(limitAccountLabel('Work ChatGPT'), 'Work ChatGPT')
  assert.equal(limitAccountLabel('a-very-long-account-name-for-the-team@example.com'), 'a-very-long-account-nam…')
})

test('a log row leaves out the generic name of an unnamed account and an account with no name', () => {
  assert.equal(limitAccountLabel('Claude account 2'), '')
  assert.equal(limitAccountLabel('ChatGPT account'), '')
  assert.equal(limitAccountLabel(undefined), '')
})
