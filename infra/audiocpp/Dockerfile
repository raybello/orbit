# audio.cpp GPU voice sidecar for Orbit: OWSM ASR, LFM3-Audio TTS and SoulX-FlashHead avatar video,
# served by audiocpp_server on :8080, plus a Caddy HTTPS front door on :8443 (audio.cpp WebUI) and
# :8444 (the Orbit web app) so browsers on other devices get a secure context for the microphone.
#
#   docker compose -f infra/compose/docker-compose.yml --profile gpu up --build
#   bash scripts/gpu-voice-stack.sh rebuild        # fresh build, models kept
#
# audio.cpp is compiled from source here, not taken from the release archive: the prebuilt Linux
# binaries leave out cuDNN, and SoulX-FlashHead's cuDNN Conv3D VAE is ~2x faster with ~44% less VRAM
# than the generic one (audio.cpp docs/models/soulx_flashhead.md). Lower latency per avatar chunk, and
# room left on a 16 GB card for a local LLM. Only the three model families Orbit uses are compiled,
# as a deployment build: that compiles their model specs in, which the published LFM3 GGUF (from
# LiquidAI, not audio.cpp) does not embed.
#
# Models are NOT baked in (~5 GB): they live on the orbit-data volume under /data/audiocpp-models and
# are fetched by download-models.py, triggered from Orbit (POST /api/voice/audiocpp/models/download)
# or at boot with AUDIOCPP_AUTO_DOWNLOAD=1.

ARG CADDY_VERSION=2.10.2
ARG CUDA_VERSION=12.8.1
FROM caddy:${CADDY_VERSION} AS caddy

# ---------- build ----------
FROM nvidia/cuda:${CUDA_VERSION}-cudnn-devel-ubuntu22.04 AS build

ARG AUDIOCPP_REF=v0.9.5
# Default: Turing → Blackwell (RTX 20xx/30xx/40xx/50xx, A100, H100). For a faster local build pass
# only your GPU's, e.g. CUDA_ARCHITECTURES=120 (scripts/gpu-voice-stack.sh does this from nvidia-smi).
ARG CUDA_ARCHITECTURES="75;80;86;89;90;120"
ARG BUILD_JOBS=0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip ninja-build build-essential libssl-dev \
 && pip3 install --no-cache-dir "cmake>=3.28,<4" \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${AUDIOCPP_REF}" https://github.com/0xShug0/audio.cpp.git /src \
 && git -C /src submodule update --init --depth 1 --recursive || true

# The CUDA driver stub lets the link step resolve libcuda without a GPU at build time.
RUN cmake -S /src -B /build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DENGINE_ENABLE_CUDA=ON \
      -DENGINE_ENABLE_CUDA_GRAPHS=ON \
      -DENGINE_ENABLE_OPENMP=ON -DGGML_OPENMP=ON \
      -DENGINE_ENABLE_NATIVE_CPU=OFF \
      -DENGINE_ENABLE_LLAMAFILE=ON \
      -DENGINE_ENABLE_VULKAN=OFF -DENGINE_ENABLE_METAL=OFF \
      -DENGINE_BUILD_TESTS=OFF \
      -DAUDIOCPP_DEPLOYMENT_BUILD=ON \
      -DAUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=OFF \
      -DAUDIOCPP_VERSION="${AUDIOCPP_REF}" \
      -DAUDIOCPP_MODEL_SET=custom \
      -DAUDIOCPP_MODELS="owsm,lfm3_audio,soulx_flashhead" \
      -DGGML_CUDA_CUDNN_CONV3D=ON \
      -DCUDNN_ROOT=/usr \
      -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}" \
      -DCMAKE_LIBRARY_PATH=/usr/local/cuda/lib64/stubs \
 && jobs="${BUILD_JOBS}"; [ "$jobs" -gt 0 ] 2>/dev/null || jobs="$(nproc)"; \
    cmake --build /build --target audiocpp_server -j "$jobs" \
 # The cuDNN Conv3D path must really be compiled in: an image without it would fail at model load.
 && grep -rqs "GGML_CUDA_CUDNN_CONV3D=1" /build/build.ninja \
 && mkdir -p /out/lib \
 && cp "$(find /build -name audiocpp_server -type f -perm -u+x | head -n1)" /out/ \
 && find /build -name '*.so*' \( -type f -o -type l \) -exec cp -a {} /out/lib/ \;

# ---------- runtime ----------
FROM nvidia/cuda:${CUDA_VERSION}-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 # libsoxr0: audio.cpp loads it at run time for the speaking-avatar recipe's streaming 24→16 kHz
 # resampler ("streaming resampling requires libsoxr" otherwise).
 && apt-get install -y --no-install-recommends libgomp1 libssl3 libsoxr0 ca-certificates python3 curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/ /opt/audiocpp/
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/audiocpp/server-config.json infra/audiocpp/download-models.py infra/audiocpp/warmup.py infra/audiocpp/entrypoint.sh /opt/audiocpp/
RUN sed -i 's/\r$//' /opt/audiocpp/entrypoint.sh /opt/audiocpp/download-models.py /opt/audiocpp/warmup.py \
 && chmod +x /opt/audiocpp/entrypoint.sh /opt/audiocpp/download-models.py /opt/audiocpp/warmup.py /opt/audiocpp/audiocpp_server \
 # Fail the build, not the first call, if a library is missing: the dlopen'd libsoxr, and every
 # linked one (libcuda comes from the NVIDIA runtime when the container starts).
 && ldconfig -p | grep -q 'libsoxr.so.0' \
 && LD_LIBRARY_PATH=/opt/audiocpp:/opt/audiocpp/lib ldd /opt/audiocpp/audiocpp_server | grep -v 'libcuda.so' | (! grep 'not found')

ENV LD_LIBRARY_PATH=/opt/audiocpp:/opt/audiocpp/lib \
    AUDIOCPP_MODELS_DIR=/data/audiocpp-models \
    XDG_DATA_HOME=/data/audiocpp-caddy \
    XDG_CONFIG_HOME=/data/audiocpp-caddy

EXPOSE 8080 8443 8444
ENTRYPOINT ["/opt/audiocpp/entrypoint.sh"]
