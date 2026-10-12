import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def test_manifesto_e_sincronizar(tmp_path, monkeypatch):
    from historico import sync

    origem = tmp_path / "origem"
    (origem / "votacao_candidato_munzona" / "ano=2022" / "turno=1").mkdir(parents=True)
    arq = origem / "votacao_candidato_munzona" / "ano=2022" / "turno=1" / "part.parquet"
    arq.write_bytes(b"PAR1-fake")
    monkeypatch.setattr(sync, "PARQUET_DIR", origem)
    man = sync.manifesto_local()
    assert man["arquivos"][0]["caminho"] == "votacao_candidato_munzona/ano=2022/turno=1/part.parquet"
    assert man["arquivos"][0]["bytes"] == 9

    # espelho público = pasta servida por HTTP com manifest.json + parquet/...
    espelho = tmp_path / "espelho"
    (espelho / "parquet").mkdir(parents=True)
    (espelho / "parquet" / "votacao_candidato_munzona" / "ano=2022" / "turno=1").mkdir(parents=True)
    (espelho / "parquet" / man["arquivos"][0]["caminho"]).write_bytes(b"PAR1-fake")
    (espelho / "manifest.json").write_text(json.dumps(man))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(espelho)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        destino = tmp_path / "destino"
        monkeypatch.setattr(sync, "PARQUET_DIR", destino)
        url = f"http://127.0.0.1:{srv.server_port}"
        assert sync.sincronizar(url, log=lambda _m: None) == 1
        assert (destino / man["arquivos"][0]["caminho"]).read_bytes() == b"PAR1-fake"
        assert sync.sincronizar(url, log=lambda _m: None) == 0  # já em dia
    finally:
        srv.shutdown()
