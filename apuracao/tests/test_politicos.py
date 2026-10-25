"""Normalização entre fontes e cruzamento mandato x candidatura (politicos/)."""

from politicos.gerar import cruzar
from politicos.texto import chave, data_iso, nome_proprio, valor_br
from politicos.tse import Candidatura


def _cand(sq, nome_civil, nascimento, cpf=""):
    return Candidatura(
        sq=sq,
        cargo="6",
        uf="SP",
        numero="1310",
        nome_urna=nome_civil,
        nome_civil=nome_civil,
        cpf=cpf,
        nascimento=nascimento,
        partido="PT",
        partido_nome="Partido",
        coligacao="",
        composicao="",
        genero="Masculino",
        instrucao="",
        ocupacao="",
        situacao="eleito",
    )


def _mand(cpf, nome_civil, nascimento):
    return {"_cpf": cpf, "_nome_civil": nome_civil, "_nascimento": nascimento}


def test_chave_ignora_acento_caixa_e_pontuacao():
    assert chave("JOSÉ  D'ÁVILA-Júnior") == chave("jose d avila junior")


def test_nome_proprio():
    assert nome_proprio("JOSÉ DA SILVA JÚNIOR") == "José da Silva Júnior"
    assert nome_proprio("DOM PEDRO II") == "Dom Pedro II"
    assert nome_proprio("ANA MARIA-JOSÉ") == "Ana Maria-José"


def test_datas_e_valores():
    assert data_iso("06/08/1989") == "1989-08-06"
    assert data_iso("2026-01-08T00:00:00") == "2026-01-08"
    assert data_iso("") is None
    assert valor_br("1.467,50") == 1467.5
    assert valor_br("1467.5") == 1467.5
    assert valor_br("") == 0.0


def test_cruzar_por_cpf_e_por_nome_com_nascimento():
    cands = {
        "1": _cand("1", "Maria da Silva", "1970-01-01", cpf="111"),
        "2": _cand("2", "José Pereira", "1960-05-05"),
        "3": _cand("3", "José Pereira", "1999-09-09"),  # homônimo: nascimento desempata
    }
    mandatos = [
        ("d10", _mand("111", "MARIA DA SILVA SOUZA", "1970-01-01")),  # nome diferente, CPF igual
        ("s20", _mand("", "JOSE PEREIRA", "1960-05-05")),
        ("s30", _mand("", "Alguém Que Não Concorreu", "1950-01-01")),
    ]
    assert cruzar(cands, mandatos) == {"d10": "1", "s20": "2"}


# ------------------------------------------------------------------ plano de governo (PDF)

from politicos.planos import Linha, sumario_proprio, titulos, titulos_por_estilo


def _corpo(n=8):
    return [
        Linha(f"texto corrido do plano, linha {i} com bastante conteúdo", 11.0, False)
        for i in range(n)
    ]


def test_sumario_proprio_acha_pagina_real_e_junta_titulo_quebrado():
    paginas = [
        [Linha("Capa do plano", 30.0, True)],
        [
            Linha("SUMÁRIO", 16.0, True),
            Linha("Saúde ........................ 2", 11.0, True),
            Linha("Educação e", 11.0, True),
            Linha("formação ........................ 3", 11.0, True),
            Linha("Segurança ........................ 4", 11.0, True),
        ],
        [Linha("SAÚDE", 18.0, True), *_corpo()],  # impresso "2", no arquivo é a página 3
        [Linha("EDUCAÇÃO E FORMAÇÃO", 18.0, True), *_corpo()],
        [*_corpo()],  # "Segurança" não aparece no corpo: página impressa + diferença típica
    ]
    assert sumario_proprio(paginas) == [
        {"t": "Saúde", "p": 3},
        {"t": "Educação e formação", "p": 4},
        {"t": "Segurança", "p": 5},
    ]


def test_sumario_proprio_para_no_indice_remissivo():
    sumario = [Linha(f"Capítulo {i} ........ {i * 10}", 11.0, False) for i in range(1, 5)]
    indice = [Linha("Agro ........ 31", 11.0, False), Linha("Bolsa ........ 12", 11.0, False)]
    paginas = [sumario + indice] + [_corpo() for _ in range(45)]
    assert [t["t"] for t in sumario_proprio(paginas)] == [f"Capítulo {i}" for i in range(1, 5)]


def test_titulos_por_estilo_ignora_cabecalho_e_repete_titulo_de_capitulo_uma_vez():
    paginas = []
    for cap in ("Economia", "Saúde"):
        for _ in range(3):  # título do capítulo no alto de cada página dele
            paginas.append(
                [Linha("PROGRAMA DE GOVERNO", 9.0, True), Linha(cap.upper(), 20.0, True), *_corpo()]
            )
    paginas += [[Linha("PROGRAMA DE GOVERNO", 9.0, True), *_corpo()] for _ in range(14)]
    assert titulos_por_estilo(paginas) == [{"t": "ECONOMIA", "p": 1}, {"t": "SAÚDE", "p": 4}]
    assert titulos(paginas) == titulos_por_estilo(paginas)  # sem sumário próprio, vale o estilo


def test_sumario_proprio_varios_titulos_na_mesma_pagina_e_item_antes_do_sumario():
    paginas = [
        [Linha("Apresentação", 18.0, True), *_corpo()],
        [
            Linha("Apresentação ........ 1", 11.0, False),
            Linha("1. Saúde ........ 3", 11.0, False),
            Linha("1.1 Atenção básica ........ 3", 11.0, False),
            Linha("2. Educação ........ 4", 11.0, False),
        ],
        [Linha("1. Saúde", 18.0, True), Linha("1.1 Atenção básica", 14.0, True), *_corpo()],
        [
            Linha("2. Educação", 18.0, True),
            Linha("menciona 1.1 Atenção básica de novo", 11.0, False),
        ],
    ]
    assert [(t["t"], t["p"]) for t in sumario_proprio(paginas)] == [
        ("Apresentação", 1),
        ("1. Saúde", 3),
        ("1.1 Atenção básica", 3),
        ("2. Educação", 4),
    ]
