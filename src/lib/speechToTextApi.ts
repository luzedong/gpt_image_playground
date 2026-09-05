export async function transcribeSpeech(audioData: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}api-speech-to-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ audioData, language: 'zh' }),
  })
  let payload: { text?: string; error?: { message?: string } } = {}
  try {
    payload = await response.json()
  } catch {
    // 由下面的 HTTP 状态统一报告错误。
  }
  if (!response.ok || !payload.text) throw new Error(payload.error?.message || `语音识别失败：HTTP ${response.status}`)
  return payload.text
}
