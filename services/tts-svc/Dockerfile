# tts-svc: Piper text-to-speech, CPU only.
#
#   docker build -t shadow-tts-svc services/tts-svc
#   docker run --rm -p 127.0.0.1:8702:8702 -v tts-voices:/voices shadow-tts-svc
#
# The voice model is NOT baked into the image: it is downloaded (SHA-256 verified)
# into the /voices volume on first start. To pre-fetch instead:
#   docker run --rm -v tts-voices:/voices shadow-tts-svc python -m tts_svc.voices
# Other known voices (python -m tts_svc.voices --list) are downloaded into /voices
# on demand, the first time a /synthesize request selects them.
#
# License note: the image contains piper-tts (GPL-3.0-or-later) and espeak-ng data
# (GPL-3.0). Distributing a built image means distributing GPL software; see README.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
# Optional build secret "ca" = extra CA bundle (PEM) for networks that intercept TLS
# (corporate proxy / antivirus HTTPS scanning):
#   docker build --secret id=ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi \
    && python -m pip install -r requirements.txt

COPY tts_svc ./tts_svc

RUN useradd --create-home --uid 10001 app && mkdir -p /voices && chown app /voices
USER app

# Inside a container the service must listen on all interfaces; publish the port
# on the host's loopback only (-p 127.0.0.1:8702:8702) to keep it local.
ENV HOST=0.0.0.0 \
    PORT=8702 \
    TTS_VOICE=tr_TR-dfki-medium \
    TTS_VOICE_DIR=/voices

VOLUME ["/voices"]
EXPOSE 8702

# start-period covers the first-start voice download (~63 MB) + load.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD python -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8702'), timeout=4).status == 200 else 1)"

CMD ["python", "-m", "tts_svc"]
