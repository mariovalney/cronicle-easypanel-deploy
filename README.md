# cronicle-easypanel-deploy

Infraestrutura do [Cronicle Edge](https://github.com/cronicle-edge/cronicle-edge) com suporte a deploy no [Easypanel](https://easypanel.io) — agendador de jobs com interface web, suporte a múltiplos servidores e plugin customizado para orquestrar deploys via containers efêmeros.

## Estrutura do repositório

```
cronicle-easypanel-deploy/
├── Dockerfile                        # Imagem baseada em cronicle/edge:latest
├── conf/
│   ├── config.json                   # Configuração principal do Cronicle
│   └── easypanel-plugin.json         # Definição do plugin Easypanel Deploy (importável)
└── plugins/
    └── easypanel-deploy.js           # Plugin: cria e faz deploy no Easypanel
```

---

## Deploy da infraestrutura

A imagem é baseada no `cronicle/edge:latest` com os plugins customizados já embutidos.

```dockerfile
FROM cronicle/edge:latest

COPY conf/config.json /opt/cronicle/conf/config.json
COPY conf/easypanel-plugin.json /opt/cronicle/conf/easypanel-plugin.json
COPY plugins /opt/cronicle/plugins
RUN chmod +x /opt/cronicle/plugins/easypanel-deploy.js

CMD ["manager"]
```

O container expõe a interface web na porta **3012** (configurado em `conf/config.json`).

### Configuração inicial

Antes de buildar, edite `conf/config.json` e ajuste:

| Chave | Descrição |
|---|---|
| `base_app_url` | URL pública do Cronicle (ex: `https://cronicle.meudominio.com`) |
| `email_from` | Endereço de e-mail remetente |
| `smtp_hostname` | Servidor SMTP |
| `job_env.BASE_URL` | URL interna do Cronicle (ex: `http://cronicle:3012`) |
| `job_env.BASE_APP_URL` | URL pública (igual ao `base_app_url`) |
| `WebServer.http_response_headers` | Adicione `Access-Control-Allow-Origin` se necessário |
| `oauth.*` | Configure se quiser login via OAuth (Microsoft, Google, etc.) |

---

## Plugins

### Easypanel Deploy (`plugins/easypanel-deploy.js`)

Cria um serviço app no [Easypanel](https://easypanel.io) a partir de um repositório GitHub (build via Dockerfile), dispara o deploy e monitora o progresso até a conclusão.

#### Como funciona

1. Lê os parâmetros do job via `stdin` (protocolo padrão do Cronicle)
2. Valida os campos obrigatórios
3. Gera o nome do serviço (com ou sem sufixo de job ID)
4. Verifica se o serviço já existe no Easypanel — se existir, falha com erro
5. Cria o serviço via API tRPC do Easypanel
6. Faz polling até o deploy concluir (container subiu) — timeout: 24 horas
7. Faz polling no Loki até encontrar a linha de status final do job (`{"complete":1,...}`)
8. Exibe os logs consolidados do container
9. **Destrói o serviço** (sempre, após ler os logs)
10. Reporta sucesso ou falha ao Cronicle com base no `code` do job

#### Pré-requisitos

- **Advanced Logs** habilitado no Easypanel — o plugin lê os logs do container via Loki (`logs.queryServiceLogs`). Sem isso, o plugin falha com erro orientativo na etapa de leitura de logs.

#### Protocolo do job (o script dentro do container)

O script que roda dentro do container deve seguir o **protocolo de log do Cronicle** — escrever linhas JSON no `stdout`:

```
{"progress": 0.2}
{"progress": 0.8}
{"complete": 1, "code": 0, "label": "Mensagem de sucesso"}
```

Em caso de falha:
```
{"complete": 1, "code": 1, "description": "Descrição do erro"}
```

Regras:
- O processo deve sempre sair com **exit 0** (para o Easypanel não restartar o container)
- A última linha com `"complete": 1` determina o resultado reportado ao Cronicle
- Se nenhuma linha de `complete` for encontrada nos logs → o plugin reporta **falha**
- Qualquer texto livre impresso no stdout também aparece nos logs do Easypanel

#### Instalando o plugin no Cronicle

O arquivo `conf/easypanel-plugin.json` contém a definição completa do plugin com todos os parâmetros pré-configurados.

**Opção A — via linha de comando (recomendado):**

```bash
# Dentro do container
/opt/cronicle/bin/control.sh import /opt/cronicle/conf/easypanel-plugin.json
```

**Opção B — via interface web (Cronicle Edge):**

1. Acesse o Cronicle → aba **Schedule**
2. Clique em **Import** (botão no canto superior direito)
3. Selecione o arquivo `conf/easypanel-plugin.json`

**Opção C — manual (UI):**

1. **Admin → Plugins → Add Plugin**
2. Name: `Easypanel Deploy`
3. Command: `/opt/cronicle/plugins/easypanel-deploy.js`
4. Adicione os parâmetros listados abaixo

#### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `easypanel_url` | text | ✓ | — | URL base do Easypanel sem barra final. Ex: `https://panel.meudominio.com` |
| `easypanel_token` | password | * | — | Token da API do Easypanel. Pode ficar vazio se `EASYPANEL_TOKEN` estiver configurado como variável de ambiente |
| `project_name` | text | ✓ | — | Nome do projeto no Easypanel. Apenas `[a-z0-9-_]` |
| `service_name` | text | ✓ | — | Nome base do serviço |
| `service_name_as_prefix` | checkbox | — | `true` | Se marcado, o nome final será `{service_name}-{job_id}` (garante unicidade entre execuções) |
| `github_owner` | text | ✓ | — | Usuário ou organização dona do repositório no GitHub |
| `github_repo` | text | ✓ | — | Nome do repositório (sem o owner) |
| `github_branch` | text | ✓ | `main` | Branch a usar no build |
| `github_build_path` | text | — | `/` | Caminho dentro do repo onde está o Dockerfile |
| `dockerfile` | text | — | `Dockerfile` | Caminho do Dockerfile relativo ao Build Path |
| `run_command` | text | — | — | Comando de runtime para sobrescrever o `CMD` do Dockerfile |
| `env_vars` | textarea | — | `{}` | Variáveis de ambiente em JSON. Ex: `{"NODE_ENV": "production", "PORT": "3000"}` |

> **\* Token via variável de ambiente:** em vez de configurar o token em cada evento, adicione-o ao `job_env` do `conf/config.json`:
>
> ```json
> "job_env": {
>   "BASE_URL": "http://cronicle:3012",
>   "BASE_APP_URL": "https://cronicle.meudominio.com",
>   "EASYPANEL_TOKEN": "seu-token-aqui"
> }
> ```

#### Exemplo de uso

Crie um evento no Cronicle com o plugin **Easypanel Deploy** e configure:

```
easypanel_url         → https://panel.meudominio.com
project_name          → minha-aplicacao
service_name          → api
service_name_as_prefix→ ✓ (marcado)
github_owner          → minha-org
github_repo           → api-backend
github_branch         → main
github_build_path     → /
dockerfile            → Dockerfile
env_vars              → {"NODE_ENV": "production"}
```

O serviço será criado com o nome `api-j3g4h5i6j7k` (nome base + job ID), garantindo que execuções paralelas não colidam.

---

## Configuração (`conf/config.json`)

Principais configurações disponíveis:

| Chave | Valor padrão | Descrição |
|---|---|---|
| `base_app_url` | `http://localhost:3012` | URL pública do Cronicle |
| `WebServer.http_port` | `3012` | Porta HTTP interna |
| `oauth.enabled` | `false` | Login via OAuth (Microsoft, Google, etc.) |
| `Storage.engine` | `Filesystem` | Storage em disco local (`data/`) |
| `job_data_expire_days` | `30` | Histórico de jobs por 30 dias |
| `job_memory_max` | `1 GB` | Limite de memória por job |

### OAuth (opcional)

Para habilitar login via Microsoft (Azure AD):

```json
"oauth": {
  "enabled": true,
  "client_id": "seu-client-id",
  "client_secret": "seu-client-secret",
  "redirect_uri": "https://cronicle.meudominio.com/api/user/callback",
  "authorize_url": "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/authorize",
  "token_url": "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token",
  "user_url": "https://graph.microsoft.com/v1.0/me",
  "user_attribute": "userPrincipalName",
  "scope": "openid profile email User.Read"
}
```

### Token do Easypanel via variável de ambiente

Para não repetir o token em cada evento do Cronicle, configure em `job_env`:

```json
"job_env": {
  "BASE_URL": "http://cronicle:3012",
  "BASE_APP_URL": "https://cronicle.meudominio.com",
  "EASYPANEL_TOKEN": "seu-token-aqui"
}
```
