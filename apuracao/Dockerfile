# Coletor / API. Build: docker build -t apuracao . ; Run: docker run --env-file .env apuracao coletar --ano 2026 --turno 2
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY pyproject.toml README.md ./
COPY apuracao ./apuracao
COPY historico ./historico
COPY chat ./chat
COPY alertas ./alertas
COPY data/ref ./data/ref
RUN pip install --no-cache-dir ".[s3,historico,chat,alertas,imagens]"

VOLUME ["/app/data"]
EXPOSE 8000 8001 8002
# Uma imagem, vários serviços: troque o comando de início por serviço (Railway/Fly/compose):
#   apuracao coletar --ano 2026 --turno 2     coletor (publica no bucket)
#   apuracao servir --port 8000               API do acervo / snapshots locais
#   python -m chat                            chat ao vivo (8001)
#   python -m alertas                         alertas (8002)
CMD ["apuracao", "coletar", "--ano", "2026", "--turno", "2"]
