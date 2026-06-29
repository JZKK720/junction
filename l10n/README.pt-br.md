# Junction

Uma barra lateral de chat para VS Code que conecta seu editor a agentes de codificação AI locais.

`7 backends` · `Barra lateral de chat` · `Contexto do workspace` · `Splash animado` · `Licença MIT`

![Dois temas familiares](../media/two_familiar_skins.png)

Junction é um painel de chat para VS Code que se conecta a agentes de codificação AI locais executados na sua máquina.
Ele se comunica com múltiplos backends de agente através de uma interface unificada — alterne entre eles sem mudar seu fluxo de trabalho.

## Backends Suportados

Junction se conecta a qualquer um destes runtimes de agente locais:

- **OpenClaw** — Integração WebSocket gateway com gerenciamento de sessão e modelo
- **Hermes** — Suporte nativo a WebSocket do dashboard e REST API
- **Souveraine** — Integração de servidor HTTP com spawning de runtime gerenciado
- **MiMoCode** — Conexão com servidor MiMo auto-iniciada ou pré-configurada
- **Goose** — Configuração de diretório de dados e chave secreta
- **OpenCode** — Configurações de caminho do binário e config home
- **OpenHands** — Lançador de servidor e configuração de diretório home

## Recursos

### Barra Lateral de Chat
Converse com seu agente ativo pela barra lateral secundária do VS Code. Abra via Command Palette: `Junction: Open Sidebar`.

### Contexto do Workspace
Arraste e solte arquivos na entrada de chat, ou clique com o botão direito em um arquivo ou seleção para adicioná-lo à thread atual.

### Seletor de Modelo e Raciocínio
Selecione um modelo e defina o esforço de raciocínio por sessão pelo cabeçalho da barra lateral.

### Renderização Markdown
Respostas do assistente, cards de chamada de tool, blocos de raciocínio e diffs são renderizados inline com destaque de sintaxe.

### Layouts de Chat
Alterne entre o modo compacto (atividade dobrada em acordeões) e o modo timeline (fluxo cronológico de raciocínio com prompts de usuário fixos).

### Modos de Follow-Up
Enfileire mensagens para quando o agente terminar, direcione no meio do turno, ou interrompa e redirecione. Configurável globalmente ou por bridge.

### Reconexão Automática
Junction reconecta ao runtime automaticamente se a conexão cair. Nenhuma reinicialização manual necessária.

## Temas

Junction inclui dois layouts embutidos. O modo **Compacto** dobra a atividade em acordeões de resumo para uma visualização densa.
O modo **Timeline** mostra uma barra de atividade cronológica com indicadores de ponto, expansão de raciocínio e um tema com destaque laranja.
Ambos os layouts se adaptam ao seu tema de cores do VS Code.

## Tela de Splash e Animações

Junction abre com uma tela de splash animada com um efeito de chuva estilo matrix atrás do logotipo.
A tela de splash é totalmente personalizável através do painel de configurações de animação no editor.

### Conjuntos de Caracteres
O efeito de chuva suporta 10 conjuntos de caracteres: Katakana, Matrix Latin, Latino, Hiragana, CJK, Hangul, Emoji, Binário, Símbolos e Personalizado.
Misture drops de emoji com raridade configurável, ou forneça seu próprio conjunto de caracteres.

### Controles de Chuva
- **Direção** — alterne a chuva caindo para cima ou para baixo
- **Chance de inversão** — defina uma porcentagem para drops irem na direção oposta
- **Ricochete nas bordas** — a chuva ricocheteia nas bordas esquerda/direita em vez de cair fora da tela
- **Gravidade, ricochete, colisão, velocidade** — ajuste como os drops se movem e interagem com o logotipo
- **Quantidade, variação de tamanho, variação de cor, faixa de opacidade** — controle a densidade e aparência da chuva
- **Cor personalizada** — escolha uma cor e alfa para a chuva e o logotipo
- **Mistura de emoji** — ative e defina a raridade como 1/N (1 = tudo emoji, 1000000 = um em um milhão)

### Animações de Saída
Quando o splash fecha, o logotipo sai por um dos 9 modos de animação.
Cada modo tem seu próprio conjunto de controles deslizantes que aparecem quando você o seleciona no menu dropdown.

- **Spiral out** — letras espiralam para fora a partir do centro
- **Spiral in** — letras convergem em uma espiral que se aperta com raio e comprimento configuráveis
- **Explode** — letras explodem para fora com gravidade
- **Explode 2** — explosão baseada em física com ricochete nas bordas, força, caos e momentum por eixo configuráveis
- **Float away** — letras flutuam para cima com inclinação baseada na direção
- **Horizontal flatten** — letras se espalham horizontalmente e esmagam em uma linha de 1px com tempo de retenção configurável
- **Explode weak** — uma explosão mais suave com menos força
- **Starwars crawl** — letras convergem para um ponto de fuga com posição Y alvo configurável
- **Explode 3** — o logotipo se fragmenta em pixels individuais com controle de momentum por eixo
- **Rain push** — letras se soltam e a chuva as empurra fisicamente para fora da tela
- **Random** — escolhe um modo diferente a cada vez

### Painel de Configurações de Animação
Abra as configurações de animação pelo ícone de engrenagem no cabeçalho do chat. Tem três abas — Chat, Bobber e Splash.
A aba Splash contém dois acordeões recolhíveis (Aparência e Movimento), o dropdown do modo de saída com controles por modo, e um canvas de pré-visualização ao vivo onde você pode clicar para testar animações.
O painel é totalmente arrastável e redimensionável sem limite de altura.

## Instalação

### A partir do código fonte
```bash
npm install
./compile-and-install.sh
# Depois: Ctrl+Shift+P → Developer: Reload Window
```

### Requisitos
- VS Code 1.120.0 ou superior
- Um runtime de agente local em execução (ex. OpenClaw Gateway, dashboard Hermes, servidor Souveraine)

---

## Créditos

Baseado em [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) por Owen-Liuyuxuan (MIT).
A infraestrutura WebSocket/gateway vem desse projeto.
A arquitetura multi-bridge, a interface webview modular, o motor de animação e os gerenciadores de modelo/sessão são originais do Junction.

---

Licença MIT. © Owen-Liuyuxuan (openclaw_vscode original), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
