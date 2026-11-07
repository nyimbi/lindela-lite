# Phase 4 and Phase 5 live status

Delivered (this session): src/model-registry.js and src/model-shadow.js,
runShadowDue wired into runPeriodicTick (src/server.js) behind
LITE_SHADOW_MODELS. Per-record action logs carry algorithm_id,
algorithm_version, inputs_hash and result. Tests test/model-shadow.test.js
and test/model-registry.test.js all green. Companion design:
docs/research/decision-models/README.md.

Not deliverable without external inputs: labeled outcome corpus + sponsor
sign-off; a quantized weight distribution via SW cache SHA-256; vendor docs
archived per CLAUDE.md sources rule.

What ships now: shadow mode idle by default. Activation: set LITE_SHADOW_MODELS=m1
then ingest; the model never changes dispatch. Go-live requires a new
MODEL_PROMOTIONS.md ADR in docs/architecture/decisions/.