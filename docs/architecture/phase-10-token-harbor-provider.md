# Phase 10 — Token Harbor as an additional text-generation provider

Status: **implemented, off by default, not yet exercised against a live Token
Harbor account.** OpenRouter remains the default provider for website and native
Android source generation. Nothing in this phase changes the generation
pipeline, the durable worker, verification, Android builds, image generation,
billing or the database schema.

---

## 1. Why a second provider

Mavly's text generation already goes through one provider-neutral boundary
(`src/lib/ai/provider.ts`), so an additional OpenAI-compatible provider can be
evaluated without a parallel pipeline. Token Harbor is integrated as an
**additional** provider for controlled testing of website/code and Android
source generation. It is never selected automatically.

## 2. Boundaries (what was touched, and what was not)

| Area | Change |
|---|---|
| `src/lib/ai/chat-contract.ts` | NEW. The provider-neutral result contract, response parsing and failure classification, extracted from the OpenRouter adapter so both adapters share one contract. Pure: no I/O, no environment, no credential names. |
| `src/lib/ai/tokenharbor.ts` | NEW. The Token Harbor adapter: endpoint, credential, request shape, provider wording. |
| `src/lib/ai/openrouter.ts` | Rebound to the shared contract. Request, headers, classification and messages are unchanged. |
| `src/lib/ai/models.ts` | Per-provider catalogs, an explicit server-controlled provider selector, and per-provider resolution. OpenRouter is still the default. |
| `src/lib/ai/provider.ts` | Dispatches `chatCompletion` to the selected provider; provider-aware configuration error. |
| `src/lib/mavly/api.ts` | The 503 copy now names the *selected* provider and its variable. |
| `src/lib/android/capability.ts` | Reports the selected provider instead of a hardcoded one. |
| `src/lib/hosting/deployment-env.ts` | `TOKEN_HARBOR_API_KEY` added to `RESERVED_ENV_KEYS`. |

Unchanged: the generation routes, `run-agent.ts`, the durable worker, admission
limits, cancellation, verification and bounded repair, Android build pipeline and
artifacts, snapshots/restore, memory, credits/billing, the image-generation route
and `openrouter-images.ts`, and every migration.

There is **no second website-generation endpoint** and no second run path: Token
Harbor is reached through the same `chatCompletion` call the pipeline already
makes.

## 3. Provider selection

* `MAVLY_AI_PROVIDER` — server-only. `openrouter` (default when unset or
  unrecognized) or `tokenharbor` (`token-harbor`, `TOKEN_HARBOR` and
  `Token Harbor` are accepted spellings — the value is case-insensitive and
  separators are ignored).
* An unrecognized value **keeps the default**. A typo can never enable a new
  provider, and there is no wildcard or "auto" mode.
* There is **no automatic provider fallback**. If the selected provider fails,
  the run records that provider's failure. A silent switch would hide a real
  provider failure, change the shipped model, and make reported cost and usage
  describe a request Mavly did not intend to make.
* The browser cannot influence any of this. Request bodies may carry a `model`
  field, but it is resolved through the *selected provider's* catalog
  (`resolveModel`), so a client value that is not exact catalog entry is
  replaced by the verified default — and a Token Harbor id resolves only when an
  operator has selected Token Harbor.
* `MAVLY_DEFAULT_MODEL` is validated per provider. Setting it to an id from the
  other provider is ignored, never forwarded.

## 4. The Token Harbor adapter

* Endpoint: `POST https://tokenharbor.ai/v1/chat/completions` (the base URL comes
  from `TOKEN_HARBOR_BASE_URL`, defaulting to `https://tokenharbor.ai/v1`).
* Auth: `Authorization: Bearer $TOKEN_HARBOR_API_KEY`. No other header is
  claimed: OpenRouter's `X-Title`/`HTTP-Referer` are **not** sent, because Token
  Harbor does not document consuming them.
* Body: `{ model, messages, temperature, max_tokens }` — OpenAI-compatible,
  non-streaming. `max_tokens` is capped by the model entry (24,000 today).
* Model: only ids in `TOKEN_HARBOR_MODEL_CATALOG`. The initial and only entry is
  `deepseek-v4.1-flash:free`. This is a **provider-local** id; the OpenRouter
  form `deepseek/deepseek-v4.1-flash` is never valid here, and each adapter
  refuses the other's ids before any network call.
  The id is confirmed by Token Harbor's own documentation (post updated
  2026-10-26), which lists `deepseek-v4.1-flash:free` — alongside
  `mimo-v2.6-flash:free` — as a currently available free route, and records that
  the earlier `claude-haiku-5.5:free` route has ended. A live
  `GET https://tokenharbor.ai/v1/models` with the operator's key is still the
  authoritative check before enabling, and no inference success is claimed by
  the documentation or by this design.
* The base URL is validated rather than trusted: it must be an absolute HTTPS URL
  with no embedded credentials, query string or fragment, or the call fails
  closed with `CONFIGURATION`.
* Timeouts use the caller's deadline or `AbortSignal.timeout`. The adapter never
  retries; bounded retry, backoff and `Retry-After` handling remain the caller's
  (`src/lib/ai/retry.ts`, `maxAttempts: 4`).
* Responses: content, `finish_reason`, usage (prompt/completion/total/reasoning
  tokens and `cost` when the provider reports it) and the request id. A missing
  usage block yields `null`s — never a fabricated count, and `reportedCostOf`
  keeps `costKnown: false`.
* Failures: `401`/`403` → `AUTHENTICATION` (not retryable); `402` → a
  quota/credit message (not retryable); `404`, `400`, `422` and a
  model-mentioning error envelope → `INVALID_REQUEST` (the copy says "does not
  serve the requested model" **only when the provider body says so**; a bare
  `404` — for example a wrong base URL — keeps the code but gets a neutral
  "rejected the request" message); `429` → `RATE_LIMITED` (retryable, with
  `Retry-After`);
  `408`/`5xx` → `TRANSIENT` (retryable); a timeout/abort → `TIMEOUT`
  (retryable); other transport errors → `NETWORK` (retryable); a green HTTP
  status carrying an error envelope is never a completion; `finish_reason:
  "length"` is always a discarded truncation (`OUTPUT_LIMIT`).
* Redaction: the key is stripped from every outbound error string and the detail
  is bounded. The adapter never logs and never returns a raw provider body.

## 5. Secrets

* `TOKEN_HARBOR_API_KEY` is server-only. It must never be given a
  `NEXT_PUBLIC_` prefix, returned from a diagnostic, written to a log, or synced
  to a generated application: it is in `RESERVED_ENV_KEYS`, so the Phase 5
  secret-sync path refuses the name. `MAVLY_AI_PROVIDER` is already covered by
  the `MAVLY_` reserved prefix.
* Configure in Vercel → Project → Settings → Environment Variables for each
  environment that should be able to select it, then redeploy. Local development
  uses `.env.local`. Never commit it.
* OpenRouter's variables are untouched by this phase.

## 6. Enabling Token Harbor for controlled testing

1. Set `TOKEN_HARBOR_API_KEY` in the target environment.
2. Set `MAVLY_AI_PROVIDER=tokenharbor`.
3. Redeploy so the runtime receives both.
4. Generate a website project and (separately) an Android project; watch the run
   row's model (`deepseek-v4.1-flash:free`) and the reported cost.
5. To restore the previous behaviour, delete `MAVLY_AI_PROVIDER` (or set it to
   `openrouter`) and redeploy. No data migration, code change or rollback is
   required; existing projects keep working and the next run uses OpenRouter
   again.

Do not enable it in a shared production environment until the free-route limits
below are understood for the expected concurrency.

## 7. Free-tier and rate-limit limitations

* The `:free` route is rate-limited by Token Harbor, not by Mavly. Mavly's own
  admission limits (1 active run per project, 2 per user, 8 global) still apply
  unchanged, and a `429` is retried within the existing bounded policy.
* A free route may report **no cost**. Mavly therefore reports `costKnown:
  false` rather than inventing a number; it does not silently price the model.
* No Mavly credit engine exists in this build, so there is no credit
  reservation or refund path to reconcile on either provider. When a credit
  engine is added it must treat both providers identically.
* Nothing here raises, bypasses or represents Token Harbor's limits, quota, SLA
  or data-handling terms. They are the operator's to confirm with the provider.

## 8. Code generation vs image generation

Token Harbor is a **text** provider. Image generation keeps its existing
OpenRouter image API path (`/api/v1/images`, `black-forest-labs/flux.2-klein-4b`)
and is never routed to Token Harbor. A model's *input* modalities are not
evidence that it can return image outputs; adding image generation to another
provider would be a separate, independently verified change. `MAVLY_IMAGE_MODEL`
and `MAVLY_DEFAULT_MODEL` remain separate selectors, and the provider selector
does not affect the image catalog.

## 9. Verification

`tests/tokenharbor-provider.test.ts` covers, with mocked HTTP only: the exact
endpoint/credential/request shape, the provider-local model id and catalog gate,
provider selection and its default-preserving behaviour, `MAVLY_DEFAULT_MODEL`
scoping, base-URL validation, success parsing, usage present/absent, empty,
malformed and wrongly-shaped bodies, truncation, authentication, quota,
unsupported-model, transient and timeout classification, `Retry-After` capping,
one-call-per-invocation, secret redaction, `RESERVED_ENV_KEYS`, server-only key
handling, pipeline neutrality, and the OpenRouter/image regressions.

**Not verified by this phase:** a real Token Harbor account, the live
`/v1/models` listing, a real free-route response, a live rate-limit response,
real end-to-end website or Android generation through Token Harbor, and the
migration-free deployment path in a real Vercel environment. The model id itself
is confirmed by the provider's own documentation (see §4). No automated check was executed during implementation
(see `AGENTS.md`); the human developer runs the suite before merge.
