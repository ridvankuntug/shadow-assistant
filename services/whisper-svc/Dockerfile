# whisper-svc on NVIDIA GPU (Linux container; on Windows via Docker Desktop + WSL2).
#
#   docker build -t shadow-whisper-svc services/whisper-svc
#   docker run --rm --gpus all -p 127.0.0.1:8701:8701 \
#       -v whisper-models:/models shadow-whisper-svc
#
# CTranslate2 (faster-whisper's backend) >= 4.5 needs CUDA 12 + cuDNN 9, which this base image provides.
# The model is NOT baked into the image: it is downloaded into the /models volume on first start
# (or mount an existing Hugging Face cache there and set HF_HUB_OFFLINE=1).
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# Optional build secret "ca" = extra CA bundle (PEM) for networks that intercept TLS
# (corporate proxy / antivirus HTTPS scanning):
#   docker build --secret id=ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi \
    && python3 -m pip install -r requirements.txt

COPY whisper_svc ./whisper_svc

RUN useradd --create-home --uid 10001 app && mkdir -p /models && chown app /models
USER app

# Inside a container the service must listen on all interfaces; publish the port
# on the host's loopback only (-p 127.0.0.1:8701:8701) to keep it local.
ENV HOST=0.0.0.0 \
    PORT=8701 \
    HF_HOME=/models \
    WHISPER_MODEL=large-v3 \
    WHISPER_DEVICE=cuda \
    WHISPER_COMPUTE_TYPE=float16

VOLUME ["/models"]
EXPOSE 8701

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD python3 -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8701'), timeout=4).status == 200 else 1)"

CMD ["python3", "-m", "whisper_svc"]
