# Embedding Providers

RagCode supports multiple embedding providers to balance between offline-first simplicity and recall quality.

## Provider Options

### 1. Deterministic (Default, Offline)

**Use when:** First run, no network, privacy-critical, or testing.

```bash
ragcode configure
# Select: deterministic (offline, no API key)
```

- ✅ Works offline, no API key needed
- ✅ Fast, deterministic, reproducible
- ⚠️ Lower recall than neural embeddings
- Uses BM25-style hashing, not learned representations

### 2. OpenAI-Compatible (Better Recall)

**Use when:** You want better semantic search and have access to an embedding API.

Supports:
- OpenAI (cloud)
- Azure OpenAI
- **Ollama (local)**
- Any OpenAI-compatible endpoint

#### OpenAI (Cloud)

```bash
export RAGCODE_EMBEDDING_PROVIDER=openai-compatible
export RAGCODE_EMBEDDING_BASE_URL=https://api.openai.com/v1
export RAGCODE_EMBEDDING_MODEL=text-embedding-3-small
export RAGCODE_EMBEDDING_API_KEY=sk-...your-key
```

Or via interactive config:

```bash
ragcode configure
# Select: openai-compatible
# Base URL: https://api.openai.com/v1
# Model: text-embedding-3-small
# API key: sk-...
```

#### Ollama (Local, Recommended)

Ollama runs embedding models locally without cloud APIs.

**Setup:**

1. Install Ollama: https://ollama.com
2. Pull an embedding model:
   ```bash
   ollama pull nomic-embed-text
   # or for multilingual:
   ollama pull mxbai-embed-large
   ```
3. Configure RagCode:
   ```bash
   ragcode configure
   ```
   - Provider: `openai-compatible`
   - Base URL: `http://localhost:11434/v1`
   - Model: `nomic-embed-text` (or your chosen model)
   - API key: `ollama` (any non-empty string works — Ollama doesn't validate keys)
   - Dimensions: leave empty (auto-detected)
   - Request dimensions: `no`

**Why a dummy API key?** Ollama doesn't require authentication, but RagCode's OpenAI-compatible provider requires a non-empty key field. Use any string (e.g., `ollama`, `local`, `not-used`).

**Recommended models:**
- `nomic-embed-text` — 768d, fast, good for code
- `mxbai-embed-large` — 1024d, multilingual
- `all-minilm` — 384d, very fast, smaller

Test the config:
```bash
ragcode configure --test
```

You should see:
```
🧪 Embedding test OK: provider=openai-compatible model=nomic-embed-text dimensions=768 latency=50ms
```

#### Azure OpenAI

```bash
export RAGCODE_EMBEDDING_PROVIDER=openai-compatible
export RAGCODE_EMBEDDING_BASE_URL=https://<your-resource>.openai.azure.com/openai/deployments/<deployment-name>
export RAGCODE_EMBEDDING_MODEL=text-embedding-ada-002
export RAGCODE_EMBEDDING_API_KEY=<azure-key>
```

## Configuration Methods

### 1. Interactive Wizard (Recommended)

```bash
ragcode configure
```

Walks through all options with validation.

### 2. Environment Variables

```bash
export RAGCODE_EMBEDDING_PROVIDER=openai-compatible
export RAGCODE_EMBEDDING_BASE_URL=http://localhost:11434/v1
export RAGCODE_EMBEDDING_MODEL=nomic-embed-text
export RAGCODE_EMBEDDING_API_KEY=ollama
```

### 3. Config File

Edit `.ragcode/config.json` directly:

```json
{
  "embeddingProvider": "openai-compatible",
  "embeddingBaseUrl": "http://localhost:11434/v1",
  "embeddingModel": "nomic-embed-text",
  "embeddingApiKey": "ollama"
}
```

## Testing Your Configuration

```bash
ragcode configure --test
```

Success output:
```
🧪 Embedding test OK: provider=openai-compatible model=nomic-embed-text dimensions=768 latency=42ms
```

Failure output explains what went wrong:
```
🧪 Embedding test FAILED (network): Failed to fetch http://localhost:11434/v1/embeddings
   Is Ollama running? Try: ollama serve
```

## Common Issues

### "Embedding provider requires an API key"

**For Ollama/local services:** Use any non-empty string (e.g., `ollama`, `local`, `dummy`).

**For cloud services:** You need a real API key from the provider.

### "Connection refused" or "ECONNREFUSED"

**Ollama not running.** Start it:
```bash
ollama serve
```

**Wrong port.** Check Ollama's port (default 11434):
```bash
curl http://localhost:11434/api/version
```

### "Model not found"

Pull the model first:
```bash
ollama pull nomic-embed-text
```

List available models:
```bash
ollama list
```

### Empty API key field in wizard

**Don't press Enter directly** on the API key prompt for local services. Enter a dummy value (e.g., `ollama`).

The wizard shows:
```
Embedding API key
> _
Enter to skip
```

For Ollama, type `ollama` and press Enter. For cloud services, paste your real key.

## Performance Notes

| Provider | Speed | Privacy | Quality |
|----------|-------|---------|---------|
| deterministic | ⚡ Fastest | 🔒 Offline | ⭐ Basic |
| Ollama (local) | ⚡ Fast | 🔒 Local | ⭐⭐⭐ Good |
| OpenAI (cloud) | ⏱️ Network | ☁️ Cloud | ⭐⭐⭐⭐ Best |

## Switching Providers

Re-run `ragcode configure` and choose a different provider. Then re-index:

```bash
ragcode index .
```

The graph (structural) index is unchanged; only embeddings are regenerated.

## References

- Ollama: https://ollama.com
- OpenAI Embeddings: https://platform.openai.com/docs/guides/embeddings
- Azure OpenAI: https://learn.microsoft.com/azure/ai-services/openai/
