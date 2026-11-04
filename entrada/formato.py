"""Números no padrão brasileiro para o terminal e a janela."""


def numero(valor: float, formato: str) -> str:
    """Formata com vírgula decimal: numero(0.5, ".2f") == "0,50"."""
    return format(valor, formato).replace(".", ",")
