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
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cu121

# Install base deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install whisperX (pulls in faster-whisper, pyannote.audio, etc.)
RUN pip install --no-cache-dir git+https://github.com/m-bain/whisperX.git

COPY main.py .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8600"]
