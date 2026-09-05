type ActiveWavRecorder = {
  stop: () => Promise<string>
  cancel: () => void
}

function encodeWav(chunks: Float32Array[], sampleRate: number) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const normalized = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
      offset += 2
    }
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return `data:audio/wav;base64,${btoa(binary)}`
}

export async function startWavRecording(): Promise<ActiveWavRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持录音')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('当前浏览器不支持音频处理')
  }
  const context = new AudioContextClass()
  const sampleRate = context.sampleRate
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let stopped = false
  processor.onaudioprocess = (event) => {
    if (!stopped) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(context.destination)

  const finish = async (cancel: boolean) => {
    if (stopped) return ''
    stopped = true
    source.disconnect()
    processor.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await context.close()
    return cancel ? '' : encodeWav(chunks, sampleRate)
  }
  return {
    stop: () => finish(false),
    cancel: () => { void finish(true) },
  }
}
