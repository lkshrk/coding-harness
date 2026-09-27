# Architecture and decisions

## Components

| Component | Choice | Custom code |
|---|---|---|
| Model gateway | LiteLLM (existing proxy) | none: model groups + aliases in gateway config |
| Harness | OpenCode (primary), DeepSeek Harness (challenger) | config rendering + event parsing (`harness.py`) |
| Agents | explorer, coder, debugger, reviewer (+ escalation = coder prompt on a frontier model) | prompts in `harnesses/opencode/agents/` |
| Sandbox | one Docker container per run, only the clone and a fresh HOME mounted | `sandbox.py` |
| Orchestration | fixed pipeline with bounded retries | `runner.py` |
| Verification | the task's own repository commands, exit codes only | `verify.py` |
| Evaluation | Arize Phoenix datasets/experiments and runner traces | `phoenix.py`, `tracing.py` |

## Decisions

1. **Finished harness, not an agent framework.** LangChain/LangGraph would mean building file editing,
   shell, compaction and permissions ourselves. OpenCode and DeepSeek Harness already provide them.
2. **Two harnesses behind one runner.** Small models are sensitive to tool-call format and prompt size,
   so the harness is an experiment variable. OpenCode: stable, per-agent models, widely used with local
   models. DeepSeek Harness: built-in token/TTFT/cache stats, but prerelease.
3. **Roles as separate headless sessions.** The runner calls each role on its own instead of letting a
   primary agent delegate. Reasons: OpenCode#51268 (subagents on local models get no tools), the
   reviewer and debugger must not inherit the coder's history, and each step becomes measurable.
4. **Logical model names at the gateway.** Harness configs only reference gateway names. Experiments
   pin concrete names (`basic/qwen3-coder-next`); `default.yaml` uses role aliases (`local-code`).
   Moving to oMLX changes gateway config only.
5. **No gateway fallbacks for the candidate models.** A fallback would hide a model failure behind
   another model's answer. Infra errors are retried by the runner on the same model instead.
6. **Three failure classes** (infra / model / verification). Only model and verification failures
   advance escalation; infra failures are retried and counted separately.
7. **Success = repository checks + hidden tests.** The model's claim of completion and the reviewer's
   verdict never decide success. The reviewer is scored on whether it agrees with the real outcome.
8. **Phoenix instead of a custom results store.** Benchmark = dataset, experiment file = experiment,
   outcome metrics = evaluators, human intervention = annotations. The runner emits one trace per run
   (run → agent calls → check rounds) straight to Phoenix. Gateway-side tracing was rejected: LiteLLM's
   `arize_phoenix` callback enabled for one key ended up tracing all proxy traffic.
9. **Starter tasks from real history** with hidden tests from the actual fix, SWE-bench style.
10. **OpenCode is the agent layer.** Its agent prompt replaces the system prompt and models, steps,
    permissions and tools are declared per agent, so what is tuned here carries over unchanged to
    interactive and production use. DeepSeek Harness stays a one-off comparison, not a candidate.
    No OpenHands arm: the choice rests on control over prompts and roles, not on score.

## Target platform

The harness sandbox is the model for production: agents work in disposable environments, people
work through the agent, not inside the environment.

```
opencode control plane      always on, web UI and sessions, no toolchains, no credentials
   │ workspace adapter       creates one sandbox per project and attaches to its server
   ▼
sandbox (agent-sandbox)     this repo's sandbox image + `opencode serve`, repo on a volume,
                            toolchain, a scoped agent token, restricted network
```

- Sandboxes: [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  (`Sandbox`, `SandboxTemplate`, `SandboxClaim`, warm pools; alpha).
- Control plane to sandbox: OpenCode's workspace control plane, which proxies sessions to a remote
  `opencode serve`. It is experimental and has no adapter for this yet; building one waits until the
  API settles.
- The existing agent platform keeps its automations until each has an equivalent here; the first one
  to move is the pull-request review.

Order: finish the harness experiments (models × roles on OpenCode), use OpenCode interactively
against the gateway meanwhile, then build the control plane and sandboxes and move automations one
at a time.

## Deviations from the original proposal

- OpenHands SDK replaced by OpenCode + DeepSeek Harness (lighter, per-agent models, local-model use;
  OpenHands sub-agent issues seen in production: no delegation in practice, open SDK bugs).
- Model line-up follows what the gateway serves: GLM 5.3 Flash, Qwen3 Coder Next, DeepSeek V4.1 Flash,
  plus Qwen3.8 Flash and Qwen3.8 27B.
- No custom results JSON/report pipeline beyond `result.json`; comparison happens in Phoenix.

## Data flow per run

```
prepare: git clone <repo>; checkout <base>        (host, into runs/<id>/repo)
start:   docker run coding-harness:<toolchain>     (mounts repo → /work, home → /home/agent)
roles:   docker exec opencode run --agent <role> --format json "<prompt>"
checks:  docker exec bash -c "<verify command>"    (stop at first failure)
hidden:  git checkout <reference> -- <hidden_tests>; rerun checks
review:  reviewer gets task + final diff only
result:  runs/<id>/result.json; runner trace in Phoenix under session <run id>
stop:    docker rm -f
```
