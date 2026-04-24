# Deepbox

Um chatbox sleek para conversar com a DeepSeek API, com streaming, modos atuais do DeepSeek V4, web context, research mode e envelopes automaticos para textos grandes colados.

## Getting Started

Crie o arquivo `.env.local` na raiz:

```bash
DEEPSEEK_API_KEY=sk-your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Instale e rode:

```bash
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Modos

- `Instant`: `deepseek-v4-flash`, thinking disabled.
- `Think`: `deepseek-v4-pro`, thinking enabled, effort high.
- `Max`: `deepseek-v4-pro`, thinking enabled, effort max.
- `Web`: busca web no backend e passa fontes para a resposta.
- `Research`: multi-busca, leitura de trechos e synthesis com thinking max.

## Texto grande colado

Ao colar um texto grande no composer, ele vira um modulo anexado automaticamente. O campo fica limpo, o modulo mostra preview/contagem, e o conteudo completo vai para o backend junto da mensagem.

## Projetos

Cada projeto tem historico proprio, nome, instrucoes persistentes e memorias fixadas. Salve um modulo grande no projeto para que ele seja reenviado como contexto em todas as proximas conversas daquele projeto.

## API notes

A DeepSeek API atual usa `deepseek-v4-pro` e `deepseek-v4-flash`. Os aliases antigos `deepseek-chat` e `deepseek-reasoner` ainda existem por compatibilidade, mas foram marcados pela DeepSeek para aposentadoria.

Web search e deep research nao sao endpoints magicos separados na API publica: este projeto implementa esses modos no backend com busca web, contexto estruturado e chamada final para a DeepSeek.

## Scripts

```bash
npm run dev
npm run lint
npm run build
```
