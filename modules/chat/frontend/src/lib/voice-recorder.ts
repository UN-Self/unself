// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 语音录制器（#218 C 路）：getUserMedia → MediaRecorder + AnalyserNode 音量采样。
 * 全部外部能力（getUserMedia/MediaRecorder/AudioContext/时钟）可注入——浏览器外
 * 可用 fake 驱动（test/voice-recorder.test.ts），生产路径走全局对象。
 * 产物：voice-<ts>.webm File + 注入时钟时长 + 42 桶波形（normalizeWaveform）。
 */
import { normalizeWaveform } from './waveform'

/** 采样周期：100ms 一个音量点。 */
const SAMPLE_INTERVAL_MS = 100
/** 波形桶数（上游 voice 附件字段口径）。 */
const WAVEFORM_BUCKETS = 42
/** 音量增益：RMS(0-1) → 0-100 的映射系数（正常说话音量落在 50-90）。 */
const GAIN = 250

export interface VoiceRecording {
  file: File
  durationMs: number
  waveform: number[]
}

/** 音频轨最小形状（真实 MediaStreamTrack 与测试 fake 共用）。 */
export interface AudioTrackLike {
  stop(): void
}

export interface MediaStreamLike {
  getTracks(): AudioTrackLike[]
}

/** AnalyserNode 最小形状：fftSize 驱动缓冲长度，getByteTimeDomainData 取波形帧。 */
export interface AnalyserLike {
  fftSize: number
  getByteTimeDomainData(array: Uint8Array): void
}

export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStreamLike): { connect(node: unknown): void }
  createAnalyser(): AnalyserLike
  close?(): Promise<void> | void
}

export type MediaRecorderCtor = new (stream: MediaStreamLike) => MediaRecorderLike

export interface MediaRecorderLike {
  start(): void
  stop(): void
  pause?(): void
  resume?(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
}

export type GetUserMediaLike = (constraints: { audio: boolean }) => Promise<MediaStreamLike>

export interface VoiceRecorderDeps {
  getUserMedia?: GetUserMediaLike
  MediaRecorder?: MediaRecorderCtor
  AudioContext?: new () => AudioContextLike
  /** 时钟（ms），默认 Date.now——测试注入可控时钟。 */
  now?: () => number
}

export interface VoiceRecorder {
  start(): Promise<void>
  stop(): Promise<VoiceRecording>
  /** 丢弃录音并释放麦克风（tracks stop）。 */
  cancel(): void
  pause(): void
  resume(): void
  readonly recording: boolean
}

function resolveDeps(deps: VoiceRecorderDeps): {
  getUserMedia: GetUserMediaLike
  MediaRecorder: MediaRecorderCtor
  AudioContext?: new () => AudioContextLike
} | null {
  const runtime = globalThis as unknown as {
    navigator?: { mediaDevices?: { getUserMedia?: GetUserMediaLike } }
    MediaRecorder?: MediaRecorderCtor
    AudioContext?: new () => AudioContextLike
  }
  const getUserMedia =
    deps.getUserMedia ?? runtime.navigator?.mediaDevices?.getUserMedia?.bind(runtime.navigator.mediaDevices)
  const MediaRecorder = deps.MediaRecorder ?? runtime.MediaRecorder
  if (!getUserMedia || !MediaRecorder) return null
  return { getUserMedia, MediaRecorder, AudioContext: deps.AudioContext ?? runtime.AudioContext }
}

/** 环境是否支持语音录制（getUserMedia + MediaRecorder 均在）。 */
export function isVoiceSupported(): boolean {
  const runtime = globalThis as unknown as {
    navigator?: { mediaDevices?: { getUserMedia?: GetUserMediaLike } }
    MediaRecorder?: MediaRecorderCtor
  }
  return Boolean(runtime.navigator?.mediaDevices?.getUserMedia && runtime.MediaRecorder)
}

export function createVoiceRecorder(deps: VoiceRecorderDeps = {}): VoiceRecorder {
  const now = deps.now ?? (() => Date.now())

  let recorder: MediaRecorderLike | null = null
  let tracks: AudioTrackLike[] = []
  let audioContext: AudioContextLike | null = null
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let chunks: Blob[] = []
  let samples: number[] = []
  let startedAtMs = 0
  let pausedAccumMs = 0
  let pausedAtMs: number | null = null

  async function start(): Promise<void> {
    if (recorder) throw new Error('VOICE_ALREADY_RECORDING')
    const resolved = resolveDeps(deps)
    if (!resolved) throw new Error('VOICE_UNSUPPORTED')

    const stream = await resolved.getUserMedia({ audio: true })
    tracks = stream.getTracks()

    const recorderInstance = new resolved.MediaRecorder(stream)
    chunks = []
    recorderInstance.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorderInstance.start()
    recorder = recorderInstance

    startedAtMs = now()
    pausedAccumMs = 0
    pausedAtMs = null
    samples = []
    startSampling(stream, resolved.AudioContext)
  }

  function startSampling(
    stream: MediaStreamLike,
    AudioContextCtor?: new () => AudioContextLike,
  ): void {
    // 采样尽力而为：无 AudioContext（或构造失败）时照常录制，仅无波形
    if (!AudioContextCtor) return
    let context: AudioContextLike
    let analyser: AnalyserLike
    try {
      context = new AudioContextCtor()
      const source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      source.connect(analyser)
    } catch {
      return
    }
    audioContext = context
    const buffer = new Uint8Array(analyser.fftSize)
    sampleTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buffer)
      let sumSquares = 0
      for (const value of buffer) {
        const deviation = (value - 128) / 128
        sumSquares += deviation * deviation
      }
      const rms = Math.sqrt(sumSquares / buffer.length)
      samples.push(Math.min(100, Math.round(rms * GAIN)))
    }, SAMPLE_INTERVAL_MS)
  }

  function stopSampling(): void {
    if (sampleTimer !== null) {
      clearInterval(sampleTimer)
      sampleTimer = null
    }
    if (audioContext) {
      const context = audioContext
      audioContext = null
      try {
        void Promise.resolve(context.close?.()).catch(() => {})
      } catch {
        /* 关闭失败不阻断收尾 */
      }
    }
  }

  function release(): void {
    stopSampling()
    for (const track of tracks) track.stop()
    tracks = []
    recorder = null
    chunks = []
    samples = []
    startedAtMs = 0
    pausedAccumMs = 0
    pausedAtMs = null
  }

  async function stop(): Promise<VoiceRecording> {
    const recorderInstance = recorder
    if (!recorderInstance) throw new Error('VOICE_NOT_RECORDING')

    const elapsedBeforePause = pausedAtMs !== null ? pausedAtMs - startedAtMs - pausedAccumMs : now() - startedAtMs - pausedAccumMs

    const stopped = new Promise<void>((resolve) => {
      recorderInstance.onstop = () => resolve()
    })
    stopSampling()
    recorderInstance.stop()
    await stopped

    const durationMs = Math.max(0, Math.round(elapsedBeforePause))
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const file = new File([blob], `voice-${Math.round(now())}.webm`, { type: 'audio/webm' })
    const waveform = normalizeWaveform(samples, WAVEFORM_BUCKETS)
    release()
    return { file, durationMs, waveform }
  }

  function cancel(): void {
    const recorderInstance = recorder
    if (!recorderInstance) return
    recorderInstance.onstop = null
    try {
      recorderInstance.stop()
    } catch {
      /* 已停止的 recorder stop 抛错可忽略 */
    }
    release()
  }

  function pause(): void {
    if (!recorder || pausedAtMs !== null) return
    recorder.pause?.()
    pausedAtMs = now()
  }

  function resume(): void {
    if (!recorder || pausedAtMs === null) return
    pausedAccumMs += Math.max(0, now() - pausedAtMs)
    pausedAtMs = null
    recorder.resume?.()
  }

  return {
    start,
    stop,
    cancel,
    pause,
    resume,
    get recording() {
      return recorder !== null
    },
  }
}
