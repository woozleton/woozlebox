FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

WORKDIR /app

# Install Python 3.11 and system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev python3-pip \
    git libsndfile1 ffmpeg \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel

# Install PyTorch with CUDA 12.1
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# Install base deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Clone ACE-Step 1.5
RUN git clone --depth 1 https://github.com/ace-step/ACE-Step-1.5.git /opt/ace-step

# Install nano-vllm from bundled third_parts
RUN pip install --no-cache-dir /opt/ace-step/acestep/third_parts/nano-vllm/ || true

# Install ACE-Step (skip torch dep since we already have it)
RUN pip install --no-cache-dir --no-deps -e /opt/ace-step
RUN pip install --no-cache-dir \
    "transformers>=4.51.0,<4.58.0" \
    diffusers \
    accelerate \
    einops \
    soundfile \
    peft \
    safetensors \
    huggingface_hub \
    loguru \
    toml \
    matplotlib \
    numba \
    lycoris-lora \
    tensorboard \
    diskcache \
    "typer-slim>=0.21.1" \
    "vector-quantize-pytorch>=1.27.15" \
    lightning

COPY main.py .

ENV ACESTEP_ROOT=/opt/ace-step

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8200"]
