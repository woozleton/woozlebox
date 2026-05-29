# tts-llm: wraps llama.cpp's llama-server in a FastAPI supervisor so
# gpu-manager can start/stop the Orpheus GGUF on demand instead of
# pinning it in VRAM for the container lifetime.
#
# The upstream image is Ubuntu-based and already ships CUDA runtime + the
# llama-server binary on PATH. We layer Python on top so the supervisor
# inherits the exact CUDA/cuBLAS/libggml libraries llama-server links against.
FROM ghcr.io/ggml-org/llama.cpp:server-cuda

# Install Python + pip on top of the llama.cpp image. The base image is
# Ubuntu 22.04 so apt is available.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /supervisor
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY supervisor.py .

EXPOSE 5006 5007

# Override the upstream entrypoint - the supervisor owns llama-server now.
ENTRYPOINT []
CMD ["python3", "-u", "supervisor.py"]
