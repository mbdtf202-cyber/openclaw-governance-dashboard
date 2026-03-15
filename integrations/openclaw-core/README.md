# OpenClaw Core Integration

The standalone plugin depends on a small amount of host-side OpenClaw wiring to
show the Governance page in Control UI.

If your target OpenClaw checkout does not already include that wiring, apply:

```bash
git apply integrations/openclaw-core/openclaw-governance-dashboard.patch
```

Recommended flow:

1. Start from a clean OpenClaw checkout.
2. Apply the patch.
3. Install the plugin release asset.
4. Restart the gateway.
5. Open the `Governance` tab.

To validate the patch against upstream OpenClaw without applying it, run:

```bash
bash scripts/check-openclaw-patch.sh
```
