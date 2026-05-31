export function l2normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

async function embedBatch(texts, cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input: texts.map((t) => t.slice(0, cfg.maxEmbedChars ?? 6000)) }),
  });
  if (!res.ok) {
    const detail = (await res.text?.().catch(() => "")) || res.status;
    throw new Error(`Ollama embed failed (${detail}). Is Ollama running and the model pulled? Run: gtir setup`);
  }
  const data = await res.json();
  if (!data.embeddings) throw new Error("Ollama returned no embeddings array");
  if (data.embeddings.length !== texts.length) {
    throw new Error(`Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs`);
  }
  return data.embeddings.map(l2normalize);
}

export async function embedTexts(texts, cfg) {
  const batch = cfg.embedBatch ?? 32;
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...await embedBatch(texts.slice(i, i + batch), cfg));
  }
  return out;
}

export async function probeDim(cfg) {
  const [v] = await embedTexts(["ping"], cfg);
  return v.length;
}
