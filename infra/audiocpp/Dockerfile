# audio.cpp GPU voice sidecar for Orbit: OWSM ASR, LFM3-Audio TTS and SoulX-FlashHead avatar video,
# served by audiocpp_server on :8080 (compose network only), plus a Caddy HTTPS front door on :8443
# (audio.cpp WebUI) and :8444 (the Orbit web app) so browsers on other devices get a secure context
# for the microphone.
#
#   docker compose -f infra/compose/docker-compose.yml --profile gpu up --build
#
# Models are NOT baked in (~5 GB): they live on the orbit-data volume under /data/audiocpp-models and
# are fetched by download-models.py — triggered from Orbit (POST /api/voice/audiocpp/models/download)
# or at boot with AUDIOCPP_AUTO_DOWNLOAD=1.

ARG CADDY_VERSION=2.10.2
FROM caddy:${CADDY_VERSION} AS caddy

# The colab release is built against CUDA 12.8 on Ubuntu 22.04. The cudnn-runtime image supplies
# cudart, cuBLAS and cuDNN 9 (SoulX's cuDNN Conv3D VAE path needs it).
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ARG AUDIOCPP_VERSION=v0.9.5
ARG AUDIOCPP_ASSET=audio-${AUDIOCPP_VERSION}-bin-ubuntu-x64-cuda12.8-colab.tar.gz

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libssl3 ca-certificates python3 curl \
 && rm -rf /var/lib/apt/lists/*

# Pre-built release: audiocpp_server, audiocpp_cli and the GGML/CUDA shared libraries.
RUN mkdir -p /opt/audiocpp \
 && curl -fsSL "https://github.com/0xShug0/audio.cpp/releases/download/${AUDIOCPP_VERSION}/${AUDIOCPP_ASSET}" -o /tmp/audiocpp.tar.gz \
 && tar -xzf /tmp/audiocpp.tar.gz -C /opt/audiocpp \
 && rm /tmp/audiocpp.tar.gz \
 # The archive may wrap everything in a top-level folder; flatten so the binaries sit in /opt/audiocpp.
 && server="$(find /opt/audiocpp -name audiocpp_server -type f | head -n1)" \
 && test -n "$server" \
 && dir="$(dirname "$server")" \
 && if [ "$dir" != /opt/audiocpp ]; then cp -a "$dir"/. /opt/audiocpp/ && rm -rf "$dir"; fi \
 && chmod +x /opt/audiocpp/audiocpp_server /opt/audiocpp/audiocpp_cli 2>/dev/null || true

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/audiocpp/server-config.json infra/audiocpp/download-models.py infra/audiocpp/entrypoint.sh /opt/audiocpp/
RUN sed -i 's/\r$//' /opt/audiocpp/entrypoint.sh /opt/audiocpp/download-models.py \
 && chmod +x /opt/audiocpp/entrypoint.sh /opt/audiocpp/download-models.py \
 # Fail the build, not the first call, if a shared library is missing (see Open Question 3).
 && LD_LIBRARY_PATH=/opt/audiocpp:/opt/audiocpp/lib ldd /opt/audiocpp/audiocpp_server | grep -v 'libcuda.so' | (! grep 'not found')

ENV LD_LIBRARY_PATH=/opt/audiocpp:/opt/audiocpp/lib \
    AUDIOCPP_MODELS_DIR=/data/audiocpp-models \
    XDG_DATA_HOME=/data/audiocpp-caddy \
    XDG_CONFIG_HOME=/data/audiocpp-caddy

EXPOSE 8080 8443 8444
ENTRYPOINT ["/opt/audiocpp/entrypoint.sh"]
