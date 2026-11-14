// Generated from the Hugging Face file listings (sizes + LFS sha256) for the local voice models.
// Regenerate with scripts/voice-models-manifest.mjs rather than editing by hand.
export interface VoiceModelFile { name: string; kind: 'stt' | 'tts' | 'espeak' | 'vad'; repo: string; path: string; size: number; sha256: string | null }

export const VOICE_MODEL_FILES: VoiceModelFile[] = [
 {
  "name": "stt-decoder-epoch-99-avg-1.int8.onnx",
  "kind": "stt",
  "repo": "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
  "path": "decoder-epoch-99-avg-1.int8.onnx",
  "size": 13091040,
  "sha256": null
 },
 {
  "name": "stt-encoder-epoch-99-avg-1.int8.onnx",
  "kind": "stt",
  "repo": "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
  "path": "encoder-epoch-99-avg-1.int8.onnx",
  "size": 181895032,
  "sha256": null
 },
 {
  "name": "stt-joiner-epoch-99-avg-1.int8.onnx",
  "kind": "stt",
  "repo": "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
  "path": "joiner-epoch-99-avg-1.int8.onnx",
  "size": 3228404,
  "sha256": null
 },
 {
  "name": "stt-tokens.txt",
  "kind": "stt",
  "repo": "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
  "path": "tokens.txt",
  "size": 56317,
  "sha256": null
 },
 {
  "name": "tts-en_US-lessac-medium.onnx",
  "kind": "tts",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "en_US-lessac-medium.onnx",
  "size": 63201425,
  "sha256": null
 },
 {
  "name": "tts-tokens.txt",
  "kind": "tts",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "tokens.txt",
  "size": 921,
  "sha256": null
 },
 {
  "name": "espeak-en_dict",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/en_dict",
  "size": 166944,
  "sha256": null
 },
 {
  "name": "espeak-intonations",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/intonations",
  "size": 2040,
  "sha256": null
 },
 {
  "name": "espeak-lang/aav/vi",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/aav/vi",
  "size": 111,
  "sha256": null
 },
 {
  "name": "espeak-lang/aav/vi-VN-x-central",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/aav/vi-VN-x-central",
  "size": 143,
  "sha256": null
 },
 {
  "name": "espeak-lang/aav/vi-VN-x-south",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/aav/vi-VN-x-south",
  "size": 142,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/eo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/eo",
  "size": 41,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/ia",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/ia",
  "size": 29,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/io",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/io",
  "size": 50,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/jbo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/jbo",
  "size": 69,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/lfn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/lfn",
  "size": 135,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/piqd",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/piqd",
  "size": 56,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/py",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/py",
  "size": 140,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/qdb",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/qdb",
  "size": 57,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/qya",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/qya",
  "size": 173,
  "sha256": null
 },
 {
  "name": "espeak-lang/art/sjn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/art/sjn",
  "size": 175,
  "sha256": null
 },
 {
  "name": "espeak-lang/azc/nci",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/azc/nci",
  "size": 114,
  "sha256": null
 },
 {
  "name": "espeak-lang/bat/lt",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/bat/lt",
  "size": 28,
  "sha256": null
 },
 {
  "name": "espeak-lang/bat/ltg",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/bat/ltg",
  "size": 312,
  "sha256": null
 },
 {
  "name": "espeak-lang/bat/lv",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/bat/lv",
  "size": 229,
  "sha256": null
 },
 {
  "name": "espeak-lang/bnt/sw",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/bnt/sw",
  "size": 41,
  "sha256": null
 },
 {
  "name": "espeak-lang/bnt/tn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/bnt/tn",
  "size": 42,
  "sha256": null
 },
 {
  "name": "espeak-lang/ccs/ka",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ccs/ka",
  "size": 124,
  "sha256": null
 },
 {
  "name": "espeak-lang/cel/cy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/cel/cy",
  "size": 37,
  "sha256": null
 },
 {
  "name": "espeak-lang/cel/ga",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/cel/ga",
  "size": 66,
  "sha256": null
 },
 {
  "name": "espeak-lang/cel/gd",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/cel/gd",
  "size": 51,
  "sha256": null
 },
 {
  "name": "espeak-lang/cus/om",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/cus/om",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-lang/dra/kn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/dra/kn",
  "size": 55,
  "sha256": null
 },
 {
  "name": "espeak-lang/dra/ml",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/dra/ml",
  "size": 57,
  "sha256": null
 },
 {
  "name": "espeak-lang/dra/ta",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/dra/ta",
  "size": 51,
  "sha256": null
 },
 {
  "name": "espeak-lang/dra/te",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/dra/te",
  "size": 70,
  "sha256": null
 },
 {
  "name": "espeak-lang/esx/kl",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/esx/kl",
  "size": 30,
  "sha256": null
 },
 {
  "name": "espeak-lang/eu",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/eu",
  "size": 54,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmq/da",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmq/da",
  "size": 43,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmq/is",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmq/is",
  "size": 27,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmq/nb",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmq/nb",
  "size": 87,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmq/sv",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmq/sv",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/af",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/af",
  "size": 123,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/de",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/de",
  "size": 42,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en",
  "size": 140,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-029",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-029",
  "size": 335,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-GB-scotland",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-GB-scotland",
  "size": 295,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-GB-x-gbclan",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-GB-x-gbclan",
  "size": 238,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-GB-x-gbcwmd",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-GB-x-gbcwmd",
  "size": 188,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-GB-x-rp",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-GB-x-rp",
  "size": 249,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-US",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-US",
  "size": 257,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/en-US-nyc",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/en-US-nyc",
  "size": 271,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/lb",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/lb",
  "size": 31,
  "sha256": null
 },
 {
  "name": "espeak-lang/gmw/nl",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/gmw/nl",
  "size": 23,
  "sha256": null
 },
 {
  "name": "espeak-lang/grk/el",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/grk/el",
  "size": 23,
  "sha256": null
 },
 {
  "name": "espeak-lang/grk/grc",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/grk/grc",
  "size": 99,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/as",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/as",
  "size": 42,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/bn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/bn",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/bpy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/bpy",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/gu",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/gu",
  "size": 42,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/hi",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/hi",
  "size": 23,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/kok",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/kok",
  "size": 26,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/mr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/mr",
  "size": 41,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/ne",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/ne",
  "size": 37,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/or",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/or",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/pa",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/pa",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/sd",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/sd",
  "size": 66,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/si",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/si",
  "size": 55,
  "sha256": null
 },
 {
  "name": "espeak-lang/inc/ur",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/inc/ur",
  "size": 94,
  "sha256": null
 },
 {
  "name": "espeak-lang/ine/hy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ine/hy",
  "size": 61,
  "sha256": null
 },
 {
  "name": "espeak-lang/ine/hyw",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ine/hyw",
  "size": 365,
  "sha256": null
 },
 {
  "name": "espeak-lang/ine/sq",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ine/sq",
  "size": 103,
  "sha256": null
 },
 {
  "name": "espeak-lang/ira/fa",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ira/fa",
  "size": 90,
  "sha256": null
 },
 {
  "name": "espeak-lang/ira/fa-Latn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ira/fa-Latn",
  "size": 269,
  "sha256": null
 },
 {
  "name": "espeak-lang/ira/ku",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ira/ku",
  "size": 40,
  "sha256": null
 },
 {
  "name": "espeak-lang/iro/chr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/iro/chr",
  "size": 569,
  "sha256": null
 },
 {
  "name": "espeak-lang/itc/la",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/itc/la",
  "size": 297,
  "sha256": null
 },
 {
  "name": "espeak-lang/jpx/ja",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/jpx/ja",
  "size": 52,
  "sha256": null
 },
 {
  "name": "espeak-lang/ko",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/ko",
  "size": 51,
  "sha256": null
 },
 {
  "name": "espeak-lang/map/haw",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/map/haw",
  "size": 42,
  "sha256": null
 },
 {
  "name": "espeak-lang/miz/mto",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/miz/mto",
  "size": 183,
  "sha256": null
 },
 {
  "name": "espeak-lang/myn/quc",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/myn/quc",
  "size": 210,
  "sha256": null
 },
 {
  "name": "espeak-lang/poz/id",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/poz/id",
  "size": 134,
  "sha256": null
 },
 {
  "name": "espeak-lang/poz/mi",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/poz/mi",
  "size": 367,
  "sha256": null
 },
 {
  "name": "espeak-lang/poz/ms",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/poz/ms",
  "size": 430,
  "sha256": null
 },
 {
  "name": "espeak-lang/qu",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/qu",
  "size": 88,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/an",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/an",
  "size": 27,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/ca",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/ca",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/es",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/es",
  "size": 63,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/es-419",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/es-419",
  "size": 167,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/fr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/fr",
  "size": 79,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/fr-BE",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/fr-BE",
  "size": 84,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/fr-CH",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/fr-CH",
  "size": 86,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/ht",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/ht",
  "size": 140,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/it",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/it",
  "size": 109,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/pap",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/pap",
  "size": 62,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/pt",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/pt",
  "size": 95,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/pt-BR",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/pt-BR",
  "size": 109,
  "sha256": null
 },
 {
  "name": "espeak-lang/roa/ro",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/roa/ro",
  "size": 26,
  "sha256": null
 },
 {
  "name": "espeak-lang/sai/gn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sai/gn",
  "size": 47,
  "sha256": null
 },
 {
  "name": "espeak-lang/sem/am",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sem/am",
  "size": 41,
  "sha256": null
 },
 {
  "name": "espeak-lang/sem/ar",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sem/ar",
  "size": 50,
  "sha256": null
 },
 {
  "name": "espeak-lang/sem/he",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sem/he",
  "size": 40,
  "sha256": null
 },
 {
  "name": "espeak-lang/sem/mt",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sem/mt",
  "size": 41,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/cmn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/cmn",
  "size": 686,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/cmn-Latn-pinyin",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/cmn-Latn-pinyin",
  "size": 161,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/hak",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/hak",
  "size": 128,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/my",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/my",
  "size": 56,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/yue",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/yue",
  "size": 194,
  "sha256": null
 },
 {
  "name": "espeak-lang/sit/yue-Latn-jyutping",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/sit/yue-Latn-jyutping",
  "size": 213,
  "sha256": null
 },
 {
  "name": "espeak-lang/tai/shn",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/tai/shn",
  "size": 92,
  "sha256": null
 },
 {
  "name": "espeak-lang/tai/th",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/tai/th",
  "size": 37,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/az",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/az",
  "size": 45,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/ba",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/ba",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/cv",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/cv",
  "size": 40,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/kk",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/kk",
  "size": 40,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/ky",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/ky",
  "size": 43,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/nog",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/nog",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/tk",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/tk",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/tr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/tr",
  "size": 25,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/tt",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/tt",
  "size": 23,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/ug",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/ug",
  "size": 24,
  "sha256": null
 },
 {
  "name": "espeak-lang/trk/uz",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/trk/uz",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-lang/urj/et",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/urj/et",
  "size": 237,
  "sha256": null
 },
 {
  "name": "espeak-lang/urj/fi",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/urj/fi",
  "size": 237,
  "sha256": null
 },
 {
  "name": "espeak-lang/urj/hu",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/urj/hu",
  "size": 73,
  "sha256": null
 },
 {
  "name": "espeak-lang/urj/smj",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/urj/smj",
  "size": 45,
  "sha256": null
 },
 {
  "name": "espeak-lang/zle/be",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zle/be",
  "size": 52,
  "sha256": null
 },
 {
  "name": "espeak-lang/zle/ru",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zle/ru",
  "size": 57,
  "sha256": null
 },
 {
  "name": "espeak-lang/zle/ru-LV",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zle/ru-LV",
  "size": 280,
  "sha256": null
 },
 {
  "name": "espeak-lang/zle/ru-cl",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zle/ru-cl",
  "size": 91,
  "sha256": null
 },
 {
  "name": "espeak-lang/zle/uk",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zle/uk",
  "size": 97,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/bg",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/bg",
  "size": 111,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/bs",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/bs",
  "size": 230,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/hr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/hr",
  "size": 262,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/mk",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/mk",
  "size": 28,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/sl",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/sl",
  "size": 43,
  "sha256": null
 },
 {
  "name": "espeak-lang/zls/sr",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zls/sr",
  "size": 250,
  "sha256": null
 },
 {
  "name": "espeak-lang/zlw/cs",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zlw/cs",
  "size": 23,
  "sha256": null
 },
 {
  "name": "espeak-lang/zlw/pl",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zlw/pl",
  "size": 38,
  "sha256": null
 },
 {
  "name": "espeak-lang/zlw/sk",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/lang/zlw/sk",
  "size": 24,
  "sha256": null
 },
 {
  "name": "espeak-phondata",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/phondata",
  "size": 550424,
  "sha256": null
 },
 {
  "name": "espeak-phondata-manifest",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/phondata-manifest",
  "size": 21821,
  "sha256": null
 },
 {
  "name": "espeak-phonindex",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/phonindex",
  "size": 39074,
  "sha256": null
 },
 {
  "name": "espeak-phontab",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/phontab",
  "size": 55796,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Alex",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Alex",
  "size": 128,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Alicia",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Alicia",
  "size": 474,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Andrea",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Andrea",
  "size": 357,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Andy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Andy",
  "size": 320,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Annie",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Annie",
  "size": 315,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/AnxiousAndy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/AnxiousAndy",
  "size": 361,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Demonic",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Demonic",
  "size": 3858,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Denis",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Denis",
  "size": 305,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Diogo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Diogo",
  "size": 379,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Gene",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Gene",
  "size": 281,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Gene2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Gene2",
  "size": 283,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Henrique",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Henrique",
  "size": 381,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Hugo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Hugo",
  "size": 378,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Jacky",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Jacky",
  "size": 267,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Lee",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Lee",
  "size": 338,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Marco",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Marco",
  "size": 467,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Mario",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Mario",
  "size": 270,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Michael",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Michael",
  "size": 270,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Mike",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Mike",
  "size": 112,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Mr serious",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Mr serious",
  "size": 3193,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Nguyen",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Nguyen",
  "size": 280,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Reed",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Reed",
  "size": 202,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/RicishayMax",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/RicishayMax",
  "size": 233,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/RicishayMax2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/RicishayMax2",
  "size": 435,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/RicishayMax3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/RicishayMax3",
  "size": 435,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Storm",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Storm",
  "size": 420,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/Tweaky",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/Tweaky",
  "size": 3189,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/UniRobot",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/UniRobot",
  "size": 417,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/adam",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/adam",
  "size": 75,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/anika",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/anika",
  "size": 493,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/anikaRobot",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/anikaRobot",
  "size": 512,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/announcer",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/announcer",
  "size": 300,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/antonio",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/antonio",
  "size": 381,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/aunty",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/aunty",
  "size": 358,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/belinda",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/belinda",
  "size": 340,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/benjamin",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/benjamin",
  "size": 201,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/boris",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/boris",
  "size": 224,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/caleb",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/caleb",
  "size": 57,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/croak",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/croak",
  "size": 93,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/david",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/david",
  "size": 112,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/ed",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/ed",
  "size": 287,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/edward",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/edward",
  "size": 151,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/edward2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/edward2",
  "size": 152,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/f1",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/f1",
  "size": 324,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/f2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/f2",
  "size": 357,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/f3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/f3",
  "size": 375,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/f4",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/f4",
  "size": 350,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/f5",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/f5",
  "size": 432,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/fast",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/fast",
  "size": 149,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/grandma",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/grandma",
  "size": 263,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/grandpa",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/grandpa",
  "size": 256,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/gustave",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/gustave",
  "size": 253,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/ian",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/ian",
  "size": 3168,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/iven",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/iven",
  "size": 261,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/iven2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/iven2",
  "size": 279,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/iven3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/iven3",
  "size": 262,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/iven4",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/iven4",
  "size": 261,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/john",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/john",
  "size": 3186,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/kaukovalta",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/kaukovalta",
  "size": 361,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt",
  "size": 38,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt2",
  "size": 38,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt3",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt4",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt4",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt5",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt5",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/klatt6",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/klatt6",
  "size": 39,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/linda",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/linda",
  "size": 350,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m1",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m1",
  "size": 335,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m2",
  "size": 264,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m3",
  "size": 300,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m4",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m4",
  "size": 290,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m5",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m5",
  "size": 262,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m6",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m6",
  "size": 188,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m7",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m7",
  "size": 254,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/m8",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/m8",
  "size": 284,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/marcelo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/marcelo",
  "size": 251,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/max",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/max",
  "size": 225,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/michel",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/michel",
  "size": 404,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/miguel",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/miguel",
  "size": 382,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/mike2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/mike2",
  "size": 188,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/norbert",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/norbert",
  "size": 3189,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/pablo",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/pablo",
  "size": 3142,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/paul",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/paul",
  "size": 284,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/pedro",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/pedro",
  "size": 352,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/quincy",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/quincy",
  "size": 354,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/rob",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/rob",
  "size": 265,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robert",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robert",
  "size": 274,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft",
  "size": 451,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft2",
  "size": 454,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft3",
  "size": 455,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft4",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft4",
  "size": 447,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft5",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft5",
  "size": 445,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft6",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft6",
  "size": 287,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft7",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft7",
  "size": 410,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/robosoft8",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/robosoft8",
  "size": 243,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/sandro",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/sandro",
  "size": 530,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/shelby",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/shelby",
  "size": 280,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/steph",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/steph",
  "size": 364,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/steph2",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/steph2",
  "size": 367,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/steph3",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/steph3",
  "size": 377,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/travis",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/travis",
  "size": 383,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/victor",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/victor",
  "size": 253,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/whisper",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/whisper",
  "size": 186,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/whisperf",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/whisperf",
  "size": 392,
  "sha256": null
 },
 {
  "name": "espeak-voices/!v/zac",
  "kind": "espeak",
  "repo": "csukuangfj/vits-piper-en_US-lessac-medium",
  "path": "espeak-ng-data/voices/!v/zac",
  "size": 275,
  "sha256": null
 },
 {
  "name": "silero_vad.onnx",
  "kind": "vad",
  "repo": "github:k2-fsa/sherpa-onnx/releases/asr-models",
  "path": "silero_vad.onnx",
  "size": 643854,
  "sha256": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
 }
];

export const VOICE_MODEL_BYTES = VOICE_MODEL_FILES.reduce((n, f) => n + f.size, 0);
