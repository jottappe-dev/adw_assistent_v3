# ADW Assistent v3

WhatsApp media downloader — baixa automaticamente imagens e vídeos de grupos do WhatsApp Web.

## Stack

| Camada | Tecnologia |
|---------|-----------|
| Shell/UI | Tauri v2 (Rust) |
| Backend | Rust (`lib.rs`, ~1500 linhas) |
| Frontend | HTML + CSS + JS vanilla |
| WhatsApp | WebView2 integrado (child window) |
| Download | WebView JS + `WAWebDownloadManager` (E2E decrypt) |

## Funcionalidades

- Extração de grupos via `window.require('WAWebCollections')`
- Download de mídias com descriptografia E2E automática
- Filtro por data (intervalo De → Até)
- Seleção de grupos (Ativo/Desativado)
- Tracking de progresso (`progress.json`)
- Zero processos externos — download 100% no WebView, sem Node.js/Puppeteer visível
- Barra de progresso em tempo real com resumo por dia
- Pesquisa/filtro de grupos
- Tema dark

## Build

```bash
npm install
npm run build
```

O instalador é gerado em `src-tauri/target/release/bundle/`.

## Estrutura

```
src/                  # Frontend (HTML, CSS, JS)
src-tauri/            # Backend Rust (Tauri v2)
├── src/lib.rs        # 26 comandos IPC + FFI Windows
├── Cargo.toml        # Dependências Rust
└── tauri.conf.json   # Configuração do Tauri
download_media.js     # Script de download (roda no WebView)
wpp_init.js           # Script de interceptação webpack
agent.js              # Agente Node.js legado (não mais usado)
```

## Licença

MIT
