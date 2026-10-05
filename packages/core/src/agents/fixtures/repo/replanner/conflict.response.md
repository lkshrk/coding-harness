The issue asks for an in-process cache, but the design runs the API as stateless replicas. Where the cache lives is a design choice the issue does not make; neither a split nor a blocker resolves it.

```json
{
  "action": "escalate_lead",
  "reason": "architectural_conflict: an in-process cache contradicts the stateless replicas in design § Deployment; the lead must choose a shared cache or invalidation scheme."
}
```
