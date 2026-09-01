import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkText, markdownToHtml, escapeHtml, isProviderFailure, formatProviderFailure } from '@evlon/dsh-bridge'

test('markdownToHtml escapes HTML and converts the conservative subset', () => {
  const html = markdownToHtml('**粗体** 与 `code` 和 <script>alert(1)</script>')
  assert.equal(html, '<b>粗体</b> 与 <code>code</code> 和 &lt;script&gt;alert(1)&lt;/script&gt;')
})

test('markdownToHtml renders fenced code blocks', () => {
  const html = markdownToHtml('前\n```\nconst x = 1 < 2\n```\n后')
  assert.equal(html, '前<br/><pre><code>const x = 1 &lt; 2</code></pre><br/>后')
})

test('chunkText returns a single unprefixed chunk under the limit', () => {
  const chunks = chunkText('短消息', 4000)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].plain, '短消息')
  assert.equal(chunks[0].html, '短消息')
})

test('chunkText splits with convergent prefixes that never outgrow capacity', () => {
  const text = '甲'.repeat(500) + '\n' + '乙'.repeat(500)
  const maxChars = 120
  const chunks = chunkText(text, maxChars)
  assert.ok(chunks.length > 1)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    assert.equal(chunk.plain.startsWith(`（${i + 1}/${chunks.length}）`), true, `prefix of chunk ${i}`)
    assert.ok(chunk.plain.length <= maxChars, `chunk ${i} length ${chunk.plain.length} <= ${maxChars}`)
  }
  assert.equal(chunks.map((c) => c.plain).join('').replaceAll(/（\d+\/\d+）/g, ''), text)
})

test('chunkText handles empty input', () => {
  assert.deepEqual(chunkText('', 4000), [])
})

test('escapeHtml escapes the three HTML metacharacters', () => {
  assert.equal(escapeHtml('<>&'), '&lt;&gt;&amp;')
})

test('isProviderFailure recognizes adapter/provider configuration errors', () => {
  assert.equal(isProviderFailure('no adapter registered for provider "sharkai"', 'sharkai', 'deepseek-v4-flash'), true)
  assert.equal(isProviderFailure('NO_ADAPTER', 'sharkai', 'deepseek-v4-flash'), true)
  assert.equal(isProviderFailure("Cannot read properties of undefined (reading 'prepare')", 'codebuddy', 'deepseek-v4-flash'), true)
  assert.equal(isProviderFailure("Cannot read properties of undefined (reading 'stream')", 'codebuddy', 'deepseek-v4-flash'), true)
  assert.equal(isProviderFailure('agent "x" has no provider/model: set AgentOptions.provider', 'codebuddy', 'deepseek-v4-flash'), true)
  assert.equal(isProviderFailure('unknown provider "foo"', 'foo', 'bar'), true)
  assert.equal(isProviderFailure('model "nonexistent" not found', 'codebuddy', 'nonexistent'), true)
})

test('isProviderFailure does not misclassify ordinary errors', () => {
  assert.equal(isProviderFailure('network timeout after 30s', 'codebuddy', 'deepseek-v4-flash'), false)
  assert.equal(isProviderFailure('rate limit exceeded', 'codebuddy', 'deepseek-v4-flash'), false)
  assert.equal(isProviderFailure('tool execution failed: file not found', 'codebuddy', 'deepseek-v4-flash'), false)
  // 弱匹配形态（credential/key/unauthorized）要求消息里出现配置的 provider/model 身份，避免误判。
  assert.equal(isProviderFailure('401 Unauthorized', undefined, undefined), false)
  assert.equal(isProviderFailure('invalid api key', undefined, undefined), false)
})

test('formatProviderFailure produces actionable Chinese guidance', () => {
  const text = formatProviderFailure('sharkai', 'deepseek-v4-flash')
  assert.match(text, /provider.*sharkai/)
  assert.match(text, /model.*deepseek-v4-flash/)
  assert.match(text, /设置.*模型/)
  assert.match(text, /\/new/)
})

test('formatProviderFailure handles empty provider/model', () => {
  const text = formatProviderFailure(undefined, undefined)
  assert.match(text, /LLM 模型不可用/)
  // 空配置时不应出现「配置的 provider：」/「配置的 model：」行（但仍保留正文泛指指引）。
  assert.doesNotMatch(text, /配置的 provider/)
  assert.doesNotMatch(text, /配置的 model/)
})
