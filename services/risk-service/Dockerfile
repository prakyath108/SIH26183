# Advisory risk service. Deliberately ships WITHOUT a model: there is no fitted
# model to commit, so the container starts unready and serves
# `ready:false, score:null`. Mount a trained artifact at /app/models and set
# MODEL_PATH to enable scoring. That way a missing model can never be mistaken
# for a healthy service that happens to be scoring everything as zero.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_PATH=/app/models/risk.joblib

# Band edges are percentile cut points, overridable without a rebuild. See
# app/bands.py; an unparseable value falls back to the defaults rather than
# reshaping every score's label.
ENV RISK_BAND_EDGES=50,75,90,97

WORKDIR /app

# scikit-learn, scipy and numpy all need no build toolchain on the manylinux
# wheels, so nothing here compiles from source.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app

# Run unprivileged; the model directory is the only writable path and is mounted
# at runtime, so the image itself needs no write access.
RUN useradd --system --uid 10001 risk && \
    mkdir -p /app/models && \
    chown -R risk:risk /app
USER risk

EXPOSE 8099

# Unfitted is a valid steady state, so health checks readiness rather than
# liveness: an unready container is still serving correct "no advisory" answers.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/healthz', timeout=2).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8099"]