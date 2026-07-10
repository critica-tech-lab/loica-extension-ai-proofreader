# loica-extension-ai-proofreader

An **on-demand AI proofreader** for Loica. To the user it's just a spell/grammar
checker — no "AI" branding. Select a passage → **Check** (in Loica's native
text-selection menu) → the fixes appear as **inline underlines**; click one to
apply. It fixes errors AND tightens wordy/redundant/weak phrasing, in place.

**Read-until-accepted** — the document only changes when you click a suggestion.

Pairs with `loica-extension-languagetool`: LanguageTool underlines errors
continuously (cheap, rule-based, automatic); this extension is the on-demand LLM
pass that also improves phrasing — the part LanguageTool can't do, and the real
lever for Spanish.

## How it works

1. **Trigger** — "Check" in the selection menu runs on the selection (never on
   keystroke; the LLM is too slow/expensive for that).
2. **Pending state** — the selection collapses and the passage gets a pulsing
   highlight + a spinner chip for the whole request, so the user sees which
   paragraph is being worked on.
3. **Rewrite → diff** — the passage is sent to an LLM (Ollama) with an *in-place
   line-editor* prompt; the returned rewrite is **word-diffed** against the
   original (client-side, self-contained) to recover **discrete, phrase-level
   changes** with exact positions. Rewrite+diff is used because small local
   models rewrite reliably but are incomplete at emitting per-edit lists.
4. **Inline underlines** — each change is a violet underline; clicking shows a
   short type/reason (heuristic — zero extra LLM call) + the fix.
5. **Cache** — results are cached by exact selection text; re-checking is instant.

| File | Role |
|------|------|
| `index.ts` / `index.server.ts` | Registry entries (`export default`). |
| `routes.ts` + `route-shim.ts` | `/api/proofread/:id` route (shim under `app/routes/`). |
| `proofread-plugin.ts` | Decorations, click-to-fix popover, pending UX, selection→diff, cache. |
| `proofread.ts` | Route `action`: auth + POST to Ollama, returns `{ improved, model }`. |

### How it plugs into loica (zero core edits)

Uses only generic extension seams — core names no extension:

- **Discovery** — `export default` in `index.ts` / `index.server.ts` / `routes.ts`;
  the host globs `app/extensions/<name>/*` and registers it. *(seam: PR #89)*
- **`editorPlugins`** — renders the underlines + popover in the editor. *(PR #89)*
- **`selectionMenuItems`** — the "Check" action in the native selection bubble. *(PR #90)*

## Config (env, on the loica server)

| Var | Default | Meaning |
|-----|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_PROOFREAD_MODEL` | `gemma3:12b` | model tag |
| `OLLAMA_KEEP_ALIVE` | `30m` | how long Ollama keeps the model resident |

`gemma3:12b` is the default: best Spanish faithfulness (fixes real errors +
tightens phrasing without drifting), ~5–6s/paragraph warm on an M4. `qwen2.5:7b`
is faster but paraphrases more. Language is auto-detected per request.

### Efficiency

- **`num_ctx` is sized to the selection** per request (2048–8192) instead of
  leaving gemma3's 128K default — a small selection gets a small KV cache (less
  VRAM, faster); big ones still fit without truncation.
- **`keep_alive`** keeps the model loaded so an on-demand check after a pause
  doesn't pay a cold reload (the biggest per-request latency win).
- Server-side Ollama tuning on limited hardware: `OLLAMA_FLASH_ATTENTION=1`,
  `OLLAMA_KV_CACHE_TYPE=q8_0`.

## Topology — running the LLM on a separate host

The LLM is heavy but on-demand, so run it on a **GPU host** (e.g. an M4 Mac),
separate from the loica server. `assertSafeUrl` refuses to send text over
plaintext to the open internet: it allows **https anywhere**, and **http only**
for loopback (`localhost`) or the Tailscale CGNAT range (`100.64.0.0/10`,
WireGuard-encrypted).

Three ways to connect a loica server to a remote Ollama:

| Method | loica `OLLAMA_URL` |
|--------|--------------------|
| Same Tailscale tailnet | `http://100.x.y.z:11434` (the LLM host's Tailscale IP) |
| **Reverse SSH tunnel** (LLM host behind NAT, server not on Tailscale) | `http://localhost:11434` |
| Public HTTPS (e.g. Cloudflare Tunnel + Access) | `https://ollama.example.com` |

### Reverse SSH tunnel (recommended when the loica server isn't on the LLM's network)

The LLM host initiates an outbound SSH tunnel that publishes Ollama on the loica
server's own `localhost:11434`. Ollama stays bound to the LLM host's localhost —
nothing is exposed; SSH provides the encryption.

On the **LLM host** (persistent via `launchd` on macOS / `systemd` on Linux, with
`autossh` to auto-reconnect):

```bash
autossh -M 0 -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:11434:127.0.0.1:11434 user@loica-server
```

- `-R 127.0.0.1:11434:...` → the server listens on **its** localhost:11434 and
  forwards to the LLM host's Ollama. Binding to `127.0.0.1` keeps it reachable
  only by processes on the server (i.e. loica).
- Needs a passwordless SSH key from the LLM host to the server.
- **Host must not sleep** and should **auto-login** (so the launchd agent starts
  after a reboot); otherwise the tunnel won't come back up unattended.

An example macOS `launchd` plist for this lives under the repo's install notes.

Verify from the loica server: `curl http://localhost:11434/api/tags`.

## Install

Requires a loica build with the generic seams (auto-discovery + `editorPlugins`
+ `selectionMenuItems` + out-of-root `~/` alias). No loica core edits:

```bash
cd /path/to/loica
ln -s /path/to/loica-extension-ai-proofreader app/extensions/ai-proofreader
cp app/extensions/ai-proofreader/route-shim.ts app/routes/api.proofread.\$id.ts
printf '/app/extensions/ai-proofreader\n/app/routes/api.proofread.\$id.ts\n' >> .git/info/exclude
bun run build && restart
# then enable "ai-proofreader" in the Extensions admin panel, with OLLAMA_URL set.
```

The host never tracks this extension: the symlink and shim are ignored via
`.git/info/exclude` (local, not the versioned `.gitignore`), keeping loica core
fully agnostic.
