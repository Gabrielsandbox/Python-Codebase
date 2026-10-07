"""Backends de publicação dos snapshots: disco local (dev) e S3/R2 (produção, atrás de CDN)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

import orjson


class Storage(Protocol):
    def write_json(self, path: str, obj: object, *, max_age: int = 10) -> None: ...
    def write_bytes(
        self, path: str, data: bytes, *, content_type: str, max_age: int = 10
    ) -> None: ...
    def read_json(self, path: str) -> object | None: ...


def dumps(obj: object) -> bytes:
    return orjson.dumps(obj, option=orjson.OPT_NON_STR_KEYS)


class LocalStorage:
    """Escreve em ``root/path`` de forma atômica (``.tmp`` + ``rename``)."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, path: str) -> Path:
        p = (self.root / path.lstrip("/")).resolve()
        if self.root.resolve() not in p.parents and p != self.root.resolve():
            raise ValueError(f"caminho fora do root: {path}")
        return p

    def write_bytes(
        self, path: str, data: bytes, *, content_type: str = "application/json", max_age: int = 10
    ) -> None:
        p = self._p(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def write_json(self, path: str, obj: object, *, max_age: int = 10) -> None:
        self.write_bytes(path, dumps(obj), content_type="application/json", max_age=max_age)

    def read_json(self, path: str) -> object | None:
        p = self._p(path)
        if not p.exists():
            return None
        return orjson.loads(p.read_bytes())


class S3Storage:
    """S3 / Cloudflare R2 / Backblaze B2 (qualquer API S3). Requer ``boto3`` (extra ``s3``).

    Em produção o bucket fica atrás de um CDN (Cloudflare) e o ``Cache-Control`` curto com
    ``stale-while-revalidate`` faz o CDN absorver todo o tráfego do público.
    """

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        endpoint_url: str | None = None,
        region: str | None = None,
    ) -> None:
        import boto3

        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self._s3 = boto3.client("s3", endpoint_url=endpoint_url, region_name=region)

    def _key(self, path: str) -> str:
        path = path.lstrip("/")
        return f"{self.prefix}/{path}" if self.prefix else path

    def write_bytes(
        self, path: str, data: bytes, *, content_type: str = "application/json", max_age: int = 10
    ) -> None:
        self._s3.put_object(
            Bucket=self.bucket,
            Key=self._key(path),
            Body=data,
            ContentType=content_type,
            CacheControl=f"public, max-age={max_age}, s-maxage={max_age}, stale-while-revalidate=30",
        )

    def write_json(self, path: str, obj: object, *, max_age: int = 10) -> None:
        self.write_bytes(path, dumps(obj), content_type="application/json", max_age=max_age)

    def read_json(self, path: str) -> object | None:
        try:
            r = self._s3.get_object(Bucket=self.bucket, Key=self._key(path))
        except self._s3.exceptions.NoSuchKey:
            return None
        return orjson.loads(r["Body"].read())


def from_env(default_root: str = "data/latest") -> Storage:
    """``APURACAO_S3_BUCKET`` definido → S3Storage; senão disco local em ``APURACAO_DATA_DIR``."""
    bucket = os.environ.get("APURACAO_S3_BUCKET")
    if bucket:
        faltam = [
            v
            for v in ("APURACAO_S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
            if not os.environ.get(v)
        ]
        if faltam:
            raise SystemExit(
                f"APURACAO_S3_BUCKET={bucket} definido, mas faltam as variáveis: "
                + ", ".join(faltam)
                + " (token R2 'Object Read & Write' e endpoint https://<account_id>.r2.cloudflarestorage.com)"
            )
        return S3Storage(
            bucket,
            prefix=os.environ.get("APURACAO_S3_PREFIX", ""),
            endpoint_url=os.environ.get("APURACAO_S3_ENDPOINT"),
            region=os.environ.get("AWS_REGION"),
        )
    return LocalStorage(os.environ.get("APURACAO_DATA_DIR", default_root))
