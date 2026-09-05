import { readFile, writeFile } from 'node:fs/promises'

const manifestPath = new URL('../public/prompt-library/cases.json', import.meta.url)
const translationsPath = new URL('./prompt-translations.ndjson', import.meta.url)

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const lines = await readFile(translationsPath, 'utf8')
  .then((value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  .catch(() => [])
const translations = new Map()

for (const line of lines) {
  const item = JSON.parse(line)
  if (!Number.isInteger(item.id) || typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error('人工译文条目格式无效')
  if (translations.has(item.id)) throw new Error(`重复的人工译文 ID：${item.id}`)
  translations.set(item.id, item.prompt.trim())
}

const cases = manifest.cases.map((item) => {
  const promptOriginal = typeof item.promptOriginal === 'string' && item.promptOriginal.trim()
    ? item.promptOriginal
    : item.prompt
  const prompt = translations.get(item.id) || item.prompt
  return {
    ...item,
    promptOriginal,
    prompt,
    promptPreview: prompt.replace(/\s+/g, ' ').slice(0, 220),
  }
})

await writeFile(manifestPath, `${JSON.stringify({ ...manifest, cases }, null, 2)}\n`, 'utf8')
console.log(`已应用 ${translations.size} 条人工译文`)
