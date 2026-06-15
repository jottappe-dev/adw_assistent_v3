# ADW Assistent v3 — Documentação Completa

## 1. O que é o projeto

O **ADW Assistent v3** é um bot automatizado para download de mídias (fotos e vídeos) de grupos do WhatsApp Web. Ele oferece:

- **Interface gráfica** com WhatsApp Web integrado (visualização e autenticação em aba própria)
- **Extração de grupos** diretamente do WhatsApp Web (sem Puppeteer, sem Node.js)
- **Download automático diário** via agendamento no Windows Task Scheduler
- **Download manual** por período de datas
- **Organização automática** dos arquivos por grupo e por data
- **Tema escuro** com design moderno (frameless window customizada)

O v3 substitui a versão anterior (Electron, ~465 MB) por Tauri v2 (Rust), resultando em um instalador de apenas **~3 MB**.

---

## 2. Stack Tecnológica

| Camada | Tecnologia | Localização |
|--------|-----------|-------------|
| Shell / UI | Tauri v2 (Rust) | `src-tauri/` |
| Backend (lógica) | Rust (`lib.rs`) | `src-tauri/src/` |
| Frontend (interface) | HTML + CSS + JS vanilla | `src/` |
| WhatsApp display | WebView2 (Tauri `WebviewWindow`) | Aba "WhatsApp Web" |
| Extração de grupos | `eval_with_callback()` (JavaScript direto no WebView2) | `lib.rs:fetch_groups` |
| Downloads de mídia | `agent.js` (Node.js + whatsapp-web.js + Puppeteer) | `agent.js` |
| Agendamento | Windows Task Scheduler (`schtasks`) | `lib.rs:schedule_task` |
| Instalador | NSIS (via Tauri bundler) | `src-tauri/target/release/bundle/nsis/` |

---

## 3. Estrutura de Pastas

```
adw_assistent_v3/
│
├── src/                          # Frontend (HTML/CSS/JS)
│   ├── index.html                # Interface com 4 abas + splash screen
│   ├── app.js                    # Lógica do frontend (~790 linhas)
│   └── style.css                 # Tema escuro completo (~360 linhas)
│
├── src-tauri/                    # Backend (Rust + Tauri)
│   ├── Cargo.toml                # Dependências Rust
│   ├── tauri.conf.json           # Config Tauri (janela frameless, bundle NSIS)
│   ├── capabilities/
│   │   ├── default.json          # Permissões padrão (IPC, dialog, fs, shell)
│   │   └── whatsapp.json         # Permissão para o webview do WhatsApp
│   ├── icons/                    # Ícones do aplicativo
│   └── src/
│       ├── main.rs               # Entry point
│       └── lib.rs                # Backend completo (~1200 linhas)
│
├── agent.js                      # Pipeline de download (Node.js + whatsapp-web.js)
├── package.json                  # Dependências npm (@tauri-apps/cli, whatsapp-web.js)
├── node_modules/                 # Pacotes npm
├── context.md                    # Documento de contexto (histórico do projeto)
├── DOCUMENTACAO.md               # Este arquivo
└── .claude/                      # Config do Claude (assistente de código)
```

---

## 4. Arquitetura da Interface

```
┌── Main Window (920x680, frameless, decorations: false) ──────┐
│ ┌── Titlebar (.tb, 48px, data-tauri-drag-region) ───────────┐ │
│ │  [⬇] ADW Assistent v3     ● Ativo    [⚙] [─] [□] [✕]     │ │
│ ├── Tabs (.tabs, 48px) ─────────────────────────────────────┤ │
│ │  Dashboard | Grupos | Agendamento | WhatsApp Web            │ │
│ ├── Content (.content, flex: 1) ────────────────────────────┤ │
│ │                                                             │ │
│ │  ← Janela WhatsApp WebView (separada, frameless)            │ │
│ │     posicionada EXATAMENTE sobre esta área via sync         │ │
│ │     sempre visível quando aba WhatsApp está ativa            │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

Janela WhatsApp (separada, frameless, skip_taskbar):
  - URL: https://web.whatsapp.com
  - userAgent: Chrome/123
  - OWNED pela janela principal via SetWindowLongPtrW(GWLP_HWNDPARENT)
  - WS_EX_TOOLWINDOW → não aparece no Alt+Tab
  - Posição sincronizada com a janela principal (DPI-aware)
  - Nunca destruída (só show/hide) → sem animação ao trocar de aba
```

---

## 5. Abas da Interface

### 5.1 Dashboard
- **Status do agendador**: mostra se a tarefa está ativa e a próxima execução
- **Execução manual**: botão "Executar Agora" com modo Automático (últimos dias) ou Manual (período de datas)
- **Barra de progresso**: mostra dias, arquivos encontrados e baixados em tempo real
- **Grupos ativos**: lista os grupos configurados com data do último download

### 5.2 Grupos
- **Buscar grupos**: botão "Atualizar grupos" extrai a lista de grupos do WhatsApp Web
- **Seleção**: ativa/desativa quais grupos monitorar
- **Reset**: reseta o estado de download de um grupo específico (começa do zero)
- **Cache**: resultados salvos em `groups-cache.json` para acesso rápido

### 5.3 Agendamento
- **Pasta de saída**: onde os arquivos serão salvos (organizados por grupo/data)
- **Horário**: define quando o agente roda automaticamente
- **Dias ignorados**: quais dias da semana pular (ex: sábado e domingo)
- **Tipos de mídia**: fotos (image) e/ou vídeos (video)
- **Retentativas**: máximo de tentativas por arquivo e intervalos entre elas
- **Agendar / Remover agendamento**: cria/deleta tarefa no Windows Task Scheduler

### 5.4 WhatsApp Web
- Exibe o WhatsApp Web em uma janela frameless posicionada sobre a área de conteúdo
- Permite autenticação via QR code
- Sessão salva em `%LOCALAPPDATA%/com.adw.assistent.v3/EBWebView/Default/`

---

## 6. Como a Extração de Grupos Funciona

### 6.1 Visão Geral

A extração de grupos **NÃO usa Puppeteer nem Node.js**. Ela usa `eval_with_callback()` — uma API do Tauri/WebView2 que executa JavaScript diretamente no webview do WhatsApp e retorna o resultado.

### 6.2 Fluxo

```
1. Usuário clica "Atualizar grupos" na aba Grupos
2. Frontend chama invoke('fetch_groups')
3. Rust (fetch_groups) obtém o WebviewWindow do WhatsApp
4. Chama wv.eval_with_callback(extract_js, callback)
5. extract_js é uma IIFE síncrona que:
   a. Verifica se window.require existe (WhatsApp carregou)
   b. Acessa window.require('WAWebCollections') — módulo interno do WhatsApp
   c. Obtém Chat.getModelsArray() — lista de todos os chats
   d. Filtra apenas grupos (isGroup === true ou id.server === 'g.us')
   e. Retorna {groups: [...], total: N} como objeto JavaScript
6. WebView2 serializa o objeto para JSON automaticamente
7. callback recebe a string JSON
8. Rust faz parse (serde_json::from_str) e emite evento 'wpp-groups'
9. Frontend recebe o evento e renderiza a lista de grupos
10. Resultado é cacheado em groups-cache.json
```

### 6.3 Por que sem Puppeteer

| Abordagem antiga (fetch_groups.js + Puppeteer) | Abordagem atual (eval_with_callback) |
|------------------------------------------------|--------------------------------------|
| Precisa de Node.js instalado | Não precisa de Node.js |
| Baixa Chromium (~300 MB na 1ª execução) | Usa o WebView2 já em execução |
| Copia perfil de sessão para temp (lento, frágil) | Acessa a memória do webview diretamente |
| Timeout de 30-90 segundos | Resposta em < 1 segundo |
| Pode falhar por arquivos travados | Sem arquivos envolvidos |
| ~82 linhas de código + dependências npm | ~60 linhas de JavaScript inline |

---

## 7. Como os Downloads Funcionam

### 7.1 Visão Geral

Os downloads de mídia são feitos pelo `agent.js` — um script Node.js que usa a biblioteca `whatsapp-web.js` com Puppeteer. Ele compartilha a sessão do WhatsApp Web copiando o perfil do WebView2 para uma pasta temporária.

### 7.2 Fluxo

```
1. Usuário clica "Executar Agora" OU o agendamento dispara
2. Frontend chama invoke('run_now', {mode, dateStart, dateEnd})
3. Rust:
   a. Copia %LOCALAPPDATA%/com.adw.assistent.v3/EBWebView/Default/
      para %TEMP%/adw_profile_<uuid>/Default/
      (pula caches pesados: Cache, GPUCache, ShaderCache, etc.)
   b. Spawn: node agent.js --data-dir <app_data> --profile <temp_profile> --from <date> --to <date>
   c. Lê stdout do agent.js linha por linha
   d. Emite eventos run-progress para cada linha de log
   e. Ao finalizar, emite run-now-done
   f. Limpa a pasta temp
4. agent.js:
   a. Cria um Client do whatsapp-web.js com NoAuth (sem authStrategy)
   b. Configura Puppeteer com userDataDir = perfil copiado (mesma sessão)
   c. Conecta ao WhatsApp (ready event)
   d. Para cada grupo ativo × cada dia no período:
      - Abre o chat do grupo
      - Busca mensagens do dia
      - Para cada mensagem com mídia (foto/vídeo):
        * Baixa o arquivo
        * Salva em <output_dir>/<grupo>/<AAAA-MM-DD>/
        * Tenta até max_retries vezes com retry_delays
   e. Reporta progresso via stdout ([ADW-EVT], [OK], [PENDENTE])
5. Frontend exibe progresso em tempo real (dias, arquivos, barra)
6. WhatsApp WebView é mantido aberto durante todo o processo
   (não fecha mais — profile copy isola o Puppeteer do WebView2)
```

### 7.3 Organização dos Arquivos Baixados

```
<output_dir>/
├── Grupo da Família/
│   ├── 2026-06-10/
│   │   ├── IMG-20260610-WA0001.jpg
│   │   ├── IMG-20260610-WA0002.jpg
│   │   └── VID-20260610-WA0003.mp4
│   └── 2026-06-11/
│       └── IMG-20260611-WA0001.jpg
├── Amigos do Trabalho/
│   └── 2026-06-10/
│       └── ...
└── ...
```

### 7.4 Profile Copy (por que e como)

O WebView2 (que exibe o WhatsApp na interface) mantém locks no perfil Chromium. O Puppeteer (que faz os downloads) não pode acessar o mesmo perfil simultaneamente.

**Solução**: Copiar o perfil para uma pasta temporária:
1. Copia `EBWebView/Default/` → `%TEMP%/adw_profile_<uuid>/Default/`
2. Pula diretórios de cache pesados (Cache, GPUCache, ShaderCache, Service Worker, etc.)
3. Copia apenas dados de sessão: Cookies, Local Storage, IndexedDB, Preferences
4. Arquivos travados individualmente são pulados (não abortam a cópia inteira)
5. Puppeteer usa `userDataDir` na cópia → mesma sessão, sem conflito
6. Após conclusão, a cópia é deletada

---

## 8. Download Automático Diário

### 8.1 Agendamento

O agendamento usa o **Windows Task Scheduler** via comando `schtasks`:

```
schtasks /Create /TN WhatsAppAgentV3 /TR "adw-assistent.exe --background-download"
         /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:00 /RL HIGHEST /F
```

- **Nome da tarefa**: WhatsAppAgentV3
- **Frequência**: Semanal, nos dias selecionados (ex: segunda a sexta)
- **Horário**: Configurável pelo usuário (padrão 08:00)
- **Ação**: Executa o próprio `adw-assistent.exe` com flag `--background-download`
- **Privilégio**: HIGHEST (executa como administrador se necessário)

### 8.2 Modo Background

Quando iniciado com `--background-download`, o app:
1. Inicia sem interface gráfica (ou minimizado)
2. Verifica a data do último download para cada grupo (state.json)
3. Determina o período pendente (última data + 1 dia até ontem)
4. Executa o `agent.js` para baixar as mídias do período
5. Atualiza `state.json` com as novas datas
6. Encerra

Isso evita baixar mídias duplicadas — cada grupo tem seu próprio "cursor" de data.

### 8.3 Controle de Estado

O arquivo `state.json` armazena a última data de download para cada grupo:
```json
{
  "grupo_da_familia": "2026-06-11",
  "amigos_do_trabalho": "2026-06-10"
}
```

- O agente só baixa mídias posteriores a essa data
- A data inicial pode ser configurada via modal de Configurações Gerais
- Resetar um grupo volta o cursor para a data inicial (ou zera)

---

## 9. Configuração e Persistência

### 9.1 Arquivos de Dados

| Arquivo | Localização | Conteúdo |
|---------|-------------|----------|
| `config.json` | `%LOCALAPPDATA%/com.adw.assistent.v3/` | Configurações do app (pastas, grupos, horários) |
| `state.json` | `%LOCALAPPDATA%/com.adw.assistent.v3/` | Estado de download por grupo (datas) |
| `groups-cache.json` | `%LOCALAPPDATA%/com.adw.assistent.v3/` | Cache da lista de grupos extraídos |
| `pending.json` | `%LOCALAPPDATA%/com.adw.assistent.v3/` | Downloads pendentes (fila) |
| `EBWebView/Default/` | `%LOCALAPPDATA%/com.adw.assistent.v3/` | Sessão do WhatsApp (cookies, localStorage, IndexedDB) |
| Backups | `%LOCALAPPDATA%/com.adw.assistent.v3/backups/` | Últimas 10 versões de config.json e state.json |

### 9.2 Configurações do Usuário

| Configuração | Descrição | Padrão |
|-------------|-----------|--------|
| `output_dir` | Pasta de saída dos downloads | (vazio — precisa configurar) |
| `skip_days` | Dias da semana ignorados (0=Dom, 6=Sáb) | [0, 6] |
| `media_types` | Tipos de mídia: "image", "video" | ["image", "video"] |
| `max_retries` | Tentativas por arquivo com falha | 3 |
| `retry_delays` | Intervalos entre tentativas (ms) | [3000, 10000, 30000] |
| `groups` | Lista de grupos (id, name, enabled) | [] |
| `agent_enabled` | Agente em segundo plano ativo? | true |
| `initial_date` | Data inicial de download (YYYY-MM-DD) | null |
| `schedule_hour` | Hora do agendamento (0-23) | 8 |
| `schedule_min` | Minuto do agendamento (0-59) | 0 |

---

## 10. Comunicação Frontend ↔ Backend (IPC)

O frontend se comunica com o backend Rust via **Tauri IPC** (`invoke` / `emit` / `listen`).

### 10.1 Comandos (Frontend → Rust)

| Comando JS | Função Rust | Descrição |
|-----------|-------------|-----------|
| `invoke('load_config')` | `load_config()` | Carrega config.json |
| `invoke('save_config', {config})` | `save_config()` | Salva config.json |
| `invoke('load_state')` | `load_state()` | Carrega state.json |
| `invoke('pick_folder')` | `pick_folder()` | Diálogo de seleção de pasta |
| `invoke('fetch_groups')` | `fetch_groups()` | Extrai grupos via eval_with_callback |
| `invoke('load_cached_groups')` | `load_cached_groups()` | Carrega cache de grupos |
| `invoke('show_wpp_webview')` | `show_wpp_webview()` | Mostra janela WhatsApp |
| `invoke('hide_wpp_webview')` | `hide_wpp_webview()` | Esconde janela WhatsApp |
| `invoke('sync_wpp_window')` | `sync_wpp_window()` | Re-sincroniza posição |
| `invoke('win_minimize')` | `win_minimize()` | Minimiza janela |
| `invoke('win_maximize')` | `win_maximize()` | Maximiza/restaura janela |
| `invoke('win_close')` | `win_close()` | Fecha app |
| `invoke('run_now', {mode, dateStart, dateEnd})` | `run_now()` | Executa download |
| `invoke('abort_download')` | `abort_download()` | Cancela download |
| `invoke('schedule_task', {hour, minute})` | `schedule_task()` | Agenda via schtasks |
| `invoke('check_task')` | `check_task()` | Verifica agendamento |
| `invoke('delete_task')` | `delete_task()` | Remove agendamento |
| `invoke('wpp_logout')` | `wpp_logout()` | Desconecta WhatsApp |
| `invoke('wpp_clear_session')` | `wpp_clear_session()` | Limpa sessão |
| `invoke('factory_reset')` | `factory_reset()` | Restaura config de fábrica |
| `invoke('apply_initial_date', {dateStrArg})` | `apply_initial_date()` | Define data inicial |
| `invoke('open_logs')` | `open_logs()` | Abre pasta de logs |
| `invoke('ping')` | `ping()` | Teste de IPC |

### 10.2 Eventos (Rust → Frontend)

| Evento | Emitido por | Finalidade |
|--------|-------------|------------|
| `run-progress` | `run_now()` | Progresso do download (fases, logs, contadores) |
| `run-now-done` | `run_now()` monitor | Download concluído (sucesso ou erro) |
| `wpp-groups` | `fetch_groups()` | Resultado da extração de grupos |
| `fetch-groups-progress` | `fetch_groups()` | Estágios da extração (init, spawn, success, error) |

---

## 11. Gerenciamento da Janela do WhatsApp

### 11.1 Criação

A janela do WhatsApp é criada uma única vez no `setup()` (thread principal):
- `WebviewWindowBuilder` com label "whatsapp"
- `decorations: false`, `skip_taskbar: true`, `resizable: false`
- `visible: false` (inicia oculta)
- `user_agent` Chrome/123

### 11.2 Integração Visual

A janela NÃO é um child webview — é uma janela separada do Windows posicionada sobre a área de conteúdo:

1. `make_window_owned()` (FFI Windows):
   - `SetWindowLongPtrW(GWLP_HWNDPARENT)` → janela principal como dona
   - `WS_EX_TOOLWINDOW` → não aparece no Alt+Tab
   - Remove `WS_EX_APPWINDOW` → não aparece na barra de tarefas
   - `SetWindowPos(SWP_FRAMECHANGED)` → aplica as mudanças de estilo

2. `sync_wpp_position()`:
   - Calcula posição: `(main.x, main.y + 96)` — abaixo da titlebar (48px) + tabs (48px)
   - Calcula tamanho: `(main.width, main.height - 96)` — preenche a área de conteúdo
   - **DPI-aware**: multiplica offset pelo `scale_factor()` do monitor

3. Sincronização:
   - `on_window_event` com `Resized` e `Moved` → reposiciona automaticamente
   - `show_wpp_webview` → sempre chama `sync_wpp_position` antes de mostrar
   - Janela nunca é destruída (só `show`/`hide`) → sem animação de abertura

### 11.3 Sessão

A sessão do WhatsApp é armazenada automaticamente pelo WebView2 em:
```
%LOCALAPPDATA%/com.adw.assistent.v3/EBWebView/Default/
```
Inclui cookies, localStorage, IndexedDB — tudo que o WhatsApp Web precisa para manter o login.

---

## 12. Splash Screen

Ao abrir o aplicativo, uma tela de inicialização é exibida por até 3 segundos:

- Fundo escuro com o logo do ADW (⬇) pulsando
- Título "ADW ASSISTENTE" em gradiente verde-azul
- Subtítulo "INICIANDO..." com 3 pontos piscando sequencialmente
- Desaparece automaticamente após 3 segundos OU assim que o IPC com o backend for estabelecido
- Transição suave com `opacity` e `pointer-events: none`

---

## 13. Build e Distribuição

### 13.1 Desenvolvimento
```bash
npm run dev      # Inicia o app em modo dev (hot reload)
```

### 13.2 Build de Produção
```bash
npm run build    # Gera .exe + instaladores
```

### 13.3 Arquivos Gerados

| Arquivo | Localização | Tamanho aprox. |
|---------|-------------|----------------|
| Executável | `src-tauri/target/release/adw-assistent.exe` | ~14 MB |
| Instalador NSIS | `src-tauri/target/release/bundle/nsis/ADW Assistent v3_x64-setup.exe` | ~3 MB |
| Instalador MSI | `src-tauri/target/release/bundle/msi/ADW Assistent v3_x64_en-US.msi` | ~3 MB |

### 13.4 Dependências para Build

- **Rust** (1.77+)
- **Node.js** (para `npm run build` e para `agent.js` em runtime)
- **NSIS** (para gerar instalador .exe)
- **WiX Toolset** (para gerar instalador .msi)

---

## 14. APIs e Comunicação Interna

### 14.1 Rust (`lib.rs`) — Principais Structs

```rust
AppState {
    config: Mutex<AppConfig>,          // Configurações do app
    download_state: Mutex<DownloadState>, // Estado do download em execução
    abort_flag: Mutex<bool>,           // Flag de cancelamento
    agent_proc: Mutex<Option<Child>>,  // Processo filho do agent.js
    wpp_child_ready: Mutex<bool>,      // Flag de inicialização do WhatsApp
}
```

### 14.2 Fluxo de Inicialização

```
1. main.rs → lib.rs::run()
2. Tauri Builder configura plugins, eventos, comandos
3. setup():
   a. Cria diretório de dados (%LOCALAPPDATA%/com.adw.assistent.v3/)
   b. Carrega config.json
   c. Inicializa AppState
   d. Cria janela WhatsApp Web (oculta) — ensure_wpp_webview()
4. Frontend carrega (index.html)
5. Splash screen aparece
6. init():
   a. Testa IPC (ping com 5 retries)
   b. Carrega config e state
   c. Verifica agendamento
   d. Tenta carregar cache de grupos
   e. Esconde splash screen
7. App pronto para uso
```

### 14.3 Tratamento de Erros

- **IPC**: 5 retries com 500ms de intervalo no startup
- **Grupos**: erros específicos (`whatsapp_not_loaded`, `no_groups_found`, `wpp_not_found`, `timeout`) com mensagens claras
- **Downloads**: progresso em tempo real, cancelamento seguro, retry automático de arquivos
- **Sessão**: opções de desconectar e limpar sessão no modal de configurações
- **Config**: backup automático (10 últimas versões) antes de cada salvamento

---

## 15. Diferenças do v2 (Electron) para o v3 (Tauri)

| Aspecto | v2 (Electron) | v3 (Tauri) |
|---------|--------------|------------|
| Tamanho do instalador | ~465 MB | ~3 MB |
| Framework | Electron (Chromium + Node.js) | Tauri v2 (Rust + WebView2 nativo) |
| Backend | Node.js | Rust (~1200 linhas) |
| Frontend | HTML/CSS/JS (mesmo) | HTML/CSS/JS (mesmo design) |
| Extração de grupos | Puppeteer + profile copy (30-90s) | eval_with_callback (< 1s) |
| WhatsApp display | WebView (Electron) | WebView2 (nativo do Windows) |
| Janela | Decorada (padrão SO) | Frameless customizada |
| RAM em idle | ~300 MB | ~50 MB |

---

## 16. Limitações Conhecidas

1. **Agendamento requer privilégios**: `schtasks /RL HIGHEST` pode exigir confirmação UAC
2. **Primeira execução do agent.js**: Puppeteer baixa Chromium (~300 MB) se não estiver em cache
3. **WebView2**: Requer Windows 10+ com WebView2 Runtime instalado (já vem no Windows 11)
4. **Apenas Windows**: Tauri compila para outros SOs, mas o app usa APIs Windows específicas (FFI, schtasks)
5. **WhatsApp Web**: Sujeito a mudanças na API interna do WhatsApp (módulos como WAWebCollections podem mudar de nome)
