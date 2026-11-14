/**
 * Minimal ambient types for sherpa-onnx-node@1.13.8.
 *
 * The npm package ships JavaScript with JSDoc annotations only: no `types` field, no `.d.ts`
 * files, so TypeScript refuses `import ... from 'sherpa-onnx-node'` without this declaration
 * (TS7016). Only the handful of members voice-runtime.ts uses are described; the package's real
 * surface is much larger (see node_modules/sherpa-onnx-node/types.js for the JSDoc typedefs).
 */
declare module 'sherpa-onnx-node' {
  /** `{ samples, sampleRate }` — mono float32 in [-1, 1]. */
  export interface WaveObject {
    samples: Float32Array;
    sampleRate: number;
    /** Set by readWave when the file is not already mono float32. */
    [extra: string]: unknown;
  }

  export interface OnlineTransducerModelConfig {
    encoder?: string;
    decoder?: string;
    joiner?: string;
  }

  export interface OnlineModelConfig {
    transducer?: OnlineTransducerModelConfig;
    tokens?: string;
    numThreads?: number;
    provider?: string;
    debug?: number | boolean;
    modelType?: string;
    modelingUnit?: string;
    bpeVocab?: string;
  }

  export interface OnlineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig?: OnlineModelConfig;
    decodingMethod?: string;
    maxActivePaths?: number;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
    hotwordsFile?: string;
    hotwordsScore?: number;
    blankPenalty?: number;
  }

  /** Result of `OnlineRecognizer.getResult`. */
  export interface OnlineRecognizerResult {
    text: string;
    tokens?: string[];
    timestamps?: number[];
    segment?: number;
    start_time?: number;
  }

  export interface OnlineStreamHandle {
    handle: unknown;
  }

  export class OnlineStream {
    acceptWaveform(obj: WaveObject): void;
    inputFinished(): void;
    setOption(key: string, value: string): void;
    getOption(key: string): string;
    hasOption(key: string): boolean;
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    decodeStreams(streams: OnlineStream[]): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
  }

  export interface OfflineTtsVitsModelConfig {
    model?: string;
    lexicon?: string;
    tokens?: string;
    dataDir?: string;
    noiseScale?: number;
    noiseScaleW?: number;
    lengthScale?: number;
  }

  export interface OfflineTtsConfig {
    model?: { vits?: OfflineTtsVitsModelConfig };
    maxNumSentences?: number;
    silenceScale?: number;
    numThreads?: number;
    provider?: string;
    debug?: number | boolean;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface TtsRequest {
    text: string;
    sid: number;
    speed: number;
  }

  export interface GenerationConfig {
    silenceScale?: number;
    speed?: number;
  }

  export class GenerationConfig {
    constructor(opts?: GenerationConfig);
  }

  export class OfflineTts {
    constructor(config: OfflineTtsConfig);
    /** Number of speakers the voice provides. */
    readonly numSpeakers: number;
    /** The voice's real output rate (22 050 Hz for Piper lessac-medium — never assumed). */
    readonly sampleRate: number;
    generate(obj: TtsRequest & { generationConfig?: GenerationConfig }): GeneratedAudio;
    generateAsync(
      obj: TtsRequest & {
        generationConfig?: GenerationConfig;
        onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
      },
    ): Promise<GeneratedAudio>;
  }

  export interface SileroVadModelConfig {
    model?: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    provider?: string;
    debug?: number | boolean;
  }

  /** A detected speech segment; `start` is its first sample index in the fed stream. */
  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
  }

  export class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
    pop(n: number): void;
    size(): number;
    head(): number;
    reset(): void;
  }

  export function readWave(filename: string, enableExternalBuffer?: boolean): WaveObject;
  export function writeWave(filename: string, obj: WaveObject): boolean;

  /** Native addon's build metadata. */
  export const version: string;
  export const gitSha1: string;
  export const gitDate: string;
  export const onnxruntimeVersion: string;
}
