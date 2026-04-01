FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

WORKDIR /app

# Install Python 3.12 and system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev python3-pip \
    git ffmpeg libgl1 libglib2.0-0 \
    && ln -sf /usr/bin/python3.12 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel --break-system-packages

# Install PyTorch 2.7 with CUDA 12.8
RUN pip install --no-cache-dir --break-system-packages \
    torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY main.py .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8300"]
