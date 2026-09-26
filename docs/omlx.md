# Moving models to oMLX

The harness never talks to a provider directly: every agent uses a gateway model name. Moving a model
to local hardware is a gateway change only.

1. Serve the model on the Mac Studio with oMLX's OpenAI-compatible server and note its base URL and
   the served model id.
2. In the gateway, point the model group at it. For LiteLLM:

   ```yaml
   - model_name: basic/qwen3-coder-next
     litellm_params:
       model: openai/<served-model-id>
       api_base: http://mac-studio.lan:<port>/v1
       api_key: none
     model_info:
       mode: chat
       max_input_tokens: 262144
       input_cost_per_token: 0
       output_cost_per_token: 0
       supports_function_calling: true
   ```

   Keep the old OpenRouter deployment under a different name (e.g. `openrouter/qwen3-coder-next`) if
   you want local-vs-remote comparisons of the same model.
3. Re-run the same experiments. Nothing in this repository changes, except optionally the context
   budgets in `experiments/_defaults.yaml` to fit local memory.

Check before trusting local results:
- tool calling works with oMLX's chat template for the model (run one task first),
- the context budget fits memory with the chosen quantization,
- `supports_function_calling` is set, otherwise some clients stop sending tools.
