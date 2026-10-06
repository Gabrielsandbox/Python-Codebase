# Coletor / API. Build: docker build -t apuracao . ; Run: docker run --env-file .env apuracao coletar --ano 2026 --turno 2
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY pyproject.toml README.md ./
COPY apuracao ./apuracao
COPY historico ./historico
COPY data/ref ./data/ref
RUN pip install --no-cache-dir ".[s3,historico]" || pip install --no-cache-dir ".[s3]"

VOLUME ["/app/data"]
EXPOSE 8000
ENTRYPOINT ["apuracao"]
CMD ["coletar", "--ano", "2026", "--turno", "2"]
