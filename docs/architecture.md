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
| Evaluation | Arize Phoenix datasets/experiments; gateway traces | `phoenix.py` |

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
   outcome metrics = evaluators, human intervention = annotations. The gateway sends the run id as the
   end-user id, which Phoenix uses as `session.id`, so all calls of one run group together.
9. **Starter tasks from real history** with hidden tests from the actual fix, SWE-bench style.

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
result:  runs/<id>/result.json; gateway traces in Phoenix under session <run id>
stop:    docker rm -f
```
