import { test as engineTest } from 'claude-code/testing'
import type { TestRest } from 'claude-code/testing'
import { installCatalogs, setLocale } from '../hooks/i18n'
import { catalogs } from './catalog-fixture'
export { expect } from 'claude-code/testing'
/** Keep historical assertions explicitly in their original locale. New default tests use enTest. */
function localized(locale: string): typeof engineTest {
  return (name: string, ...rest: TestRest) => {
    const body = rest[rest.length - 1] as import('claude-code/testing').TestBody
    const wrapped: import('claude-code/testing').TestBody = async ($, on) => {
      installCatalogs(catalogs); setLocale(locale)
      on('settings.read', () => ({ value: { language: locale } }))
      return body($, on)
    }
    // Full hook tests exercise several file/state rounds; avoid the engine's 5s wall-clock default under shared host load.
    if (rest.length === 1) engineTest(name, { timeoutMs: 20_000 }, wrapped)
    else engineTest(name, { timeoutMs: 20_000, ...(rest[0] as import('claude-code/testing').TestOptions) }, wrapped)
  }
}
export const test = localized('zh-CN')
export const enTest = localized('en')
