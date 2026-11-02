# Kubernetes deployment

Manifests for a dashboard, a daily CronJob and an alert watcher.

## Your own values

The files here are a base with placeholders. Keep your real values in a
gitignored overlay at `k8s-local/`, and apply that instead of `k8s/`:

```yaml
# k8s-local/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../k8s
images:
  - name: registry.example.com/sol-swapper
    newName: registry.yourdomain.example/sol-swapper
patches:
  - target: { kind: ConfigMap, name: sol-swapper-config }
    patch: |-
      - { op: replace, path: /data/TRANSFER_DESTINATION, value: "<your wallet>" }
      - { op: replace, path: /data/DASHBOARD_PUBLIC_ORIGIN, value: "https://<your host>" }
  - target: { kind: Ingress, name: sol-swapper }
    patch: |-
      - { op: replace, path: /spec/rules/0/host, value: "<your host>" }
      - { op: replace, path: /spec/tls/0/hosts/0, value: "<your host>" }
```

`TRANSFER_DESTINATION` is deliberately invalid in the base, so a dashboard
deployed without the overlay refuses to start instead of moving funds. The
namespace (`nikhil`) is set in each manifest and in `make-secret.sh`; change
all of them to use another. The watcher also needs a `sol-swapper-telegram`
Secret holding `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Examples below use
`k8s/` paths; substitute your overlay.

Three workloads from one image:

| | kind | why |
|---|---|---|
| `sol-swapper` | Deployment + Service + Ingress | the dashboard, long-running |
| `sol-swapper-run` | CronJob, 09:15/13:15/17:15 IST | the daily buy — this replaces launchd |
| `sol-swapper-alerts` | Deployment, 1 replica | price alerts → Telegram, checks every minute |

`run.js` is a short-lived process that exits, which is exactly a CronJob. The
dashboard cannot trigger a swap over HTTP. It has exactly one write route —
the custody transfer — and it is off by default (`TRANSFER_HTTP_ENABLED`).

## First deploy

```bash
# 1. database on a shared instance
kubectl -n db exec postgres-0 -- psql -U postgres -d postgres -c '
  CREATE DATABASE "sol-swapper";
  CREATE ROLE solswapper LOGIN PASSWORD ...;
  GRANT ALL PRIVILEGES ON DATABASE "sol-swapper" TO solswapper;'
kubectl -n db exec postgres-0 -- psql -U postgres -d sol-swapper -c '
  ALTER SCHEMA public OWNER TO solswapper;'   # PG15+ revokes CREATE on public

# 2. build and push (cluster is amd64; a Mac is arm64)
docker buildx build --platform linux/amd64 \
  -t registry.example.com/sol-swapper:latest --push .

# 3. secret, from your gitignored .env
./k8s/make-secret.sh          # --dry-run to preview, redacted

# 4. everything else
kubectl apply -k k8s/

# 5. schema
kubectl -n nikhil run sol-swapper-migrate --rm -i --restart=Never \
  --image=registry.example.com/sol-swapper:latest \
  --overrides='{"spec":{"imagePullSecrets":[{"name":"docker-registry-auth"}],
    "containers":[{"name":"m","image":"registry.example.com/sol-swapper:latest",
    "command":["node","migrate.js"],
    "envFrom":[{"configMapRef":{"name":"sol-swapper-config"}},
               {"secretRef":{"name":"sol-swapper-secrets"}}]}]}}'
```

## Day to day

```bash
kubectl -n nikhil logs -f deploy/sol-swapper           # dashboard
kubectl -n nikhil logs -f deploy/sol-swapper-alerts    # alerts: fired / rearmed / errors
kubectl -n nikhil exec deploy/sol-swapper-alerts -- node alerts-cli.js list
kubectl -n nikhil get cronjob sol-swapper-run          # next scheduled run
kubectl -n nikhil logs -l job-name --tail=50           # last run's output
kubectl -n nikhil create job manual-$(date +%s) --from=cronjob/sol-swapper-run
```

Redeploy after a code change:

```bash
docker buildx build --platform linux/amd64 \
  -t registry.example.com/sol-swapper:latest --push .
kubectl -n nikhil rollout restart deploy/sol-swapper deploy/sol-swapper-alerts
```

The CronJob picks the new image up on its next run (`imagePullPolicy: Always`).

## Notes that will save you an hour

- **`K8S_DATABASE_URL` in `.env`** is what `make-secret.sh` ships. The plain
  `DATABASE_URL` stays pointed at your local Docker Postgres, which no pod can
  reach; the script refuses to deploy a loopback URL rather than shipping a
  broken secret.
- **Probes hit `/healthz`, not `/`.** `/` returns 401, and Kubernetes treats
  any status ≥400 as a failed probe — pointing liveness at `/` gets the pod
  killed in a loop. `/healthz` is unauthenticated and touches neither Postgres
  nor Jupiter, so an outage in either can't cause a restart storm.
- **`DASHBOARD_HOST` must be `0.0.0.0`** in-cluster (set in the ConfigMap).
  The local default of `127.0.0.1` would refuse the kubelet's probes and all
  Service traffic.
- **The secret is never committed.** `01-secret.example.yaml` is a template and
  is not in `kustomization.yaml`; the real one comes from `make-secret.sh`.
  Anyone who can read it can spend the wallet — keep namespace RBAC tight.
- **A retry is safe by construction.** `run.js` writes a pending intent before
  each swap and reconciles it on the next start, so `backoffLimit: 1` resolves
  a mid-swap crash rather than repeating the buy. `concurrencyPolicy: Forbid`
  plus the Postgres advisory lock make overlap impossible.
- **Three schedules, one buy.** `run.js` is idempotent on the UTC date, so the
  first successful run of the day buys and the others no-op in ~1s. The extra
  attempts exist so a transient failure at 09:15 becomes a delayed buy rather
  than a missed day.
- **A missed window is not a missed buy.** Budget accrues daily, so
  `startingDeadlineSeconds: 3600` runs late rather than skipping.
- **`DRY_RUN=true` in the ConfigMap** makes the CronJob quote and log without
  submitting. Worth a week of that before it spends real money.


## Moving the position to the safe wallet

The destination lives in the **ConfigMap**, not the Secret: it is a public
address, and it is the one value in this deployment most worth being able to
audit with `kubectl describe`. A request can never override it, which is what
bounds a stolen dashboard password to griefing rather than theft.

The button is off by default. To use it:

```bash
kubectl -n nikhil edit configmap sol-swapper-config   # TRANSFER_HTTP_ENABLED: "true"
kubectl -n nikhil rollout restart deployment/sol-swapper
# ...move the funds from the dashboard, then turn it back off and restart again.
```

Or skip the button entirely and use the CLI in the pod, which needs no config
change (`TRANSFER_ENABLED` is already true):

```bash
kubectl -n nikhil exec -it deploy/sol-swapper -- node transfer.js --dry-run --yes
kubectl -n nikhil exec -it deploy/sol-swapper -- node transfer.js
```

### Schema migrations come first

`transactions.type` has a CHECK constraint, so a database that has not been
migrated **rejects the ledger row after the coins have already moved**. Always:

```bash
kubectl -n nikhil delete job sol-swapper-migrate --ignore-not-found
kubectl apply -f k8s/06-migrate-job.yaml
kubectl -n nikhil wait --for=condition=complete job/sol-swapper-migrate --timeout=120s
# only then roll out the new image
```

`06-migrate-job.yaml` is deliberately not in `kustomization.yaml` — a Job's pod
template is immutable, so `apply -k` would fail on every run after the first.

### About the private key in this pod

The dashboard pod signs the transfer, so `PRIVATE_KEY` has to be there and the
`envFrom` on `sol-swapper-secrets` stays. The pinned destination gives no
protection against code execution in this process — an attacker who can run
code reads the environment and ignores your config — so the body-size cap, the
JSON-only parse and the strict route allow-list in `server.js` are the real
defence, not decoration.

If you ever want to remove the key from this pod, `server.js` already reads
`WALLET_PUBKEY` in preference to loading the keypair. Set it, drop
`TRANSFER_HTTP_ENABLED`, give the dashboard its own Secret without
`PRIVATE_KEY`, and move funds with the CLI from the CronJob image instead.

## Price alerts

`sol-swapper-alerts` runs `watch.js`. Once a minute it reads the active alerts,
prices every symbol in one Jupiter call, and sends any that trigger to
Telegram. Alerts are added and removed on the dashboard, or with
`node alerts-cli.js` in any of the pods.

The Telegram bot token and chat ID come from the `sol-swapper-telegram` Secret,
which the Deployment mounts directly. So there is one token to rotate, and if
that Secret is deleted, this pod stops starting rather than failing quietly. The watcher refuses to boot without
both values.

The pod receives `DATABASE_URL` and `JUPITER_API_KEY` by key, never the whole
`sol-swapper-secrets`, so the wallet key is not in its environment.

First rollout:

```bash
kubectl -n nikhil delete job sol-swapper-migrate --ignore-not-found
kubectl apply -f k8s/06-migrate-job.yaml           # creates price_alerts
kubectl -n nikhil wait --for=condition=complete job/sol-swapper-migrate --timeout=120s
kubectl apply -k k8s/
kubectl -n nikhil exec deploy/sol-swapper-alerts -- node alerts-cli.js test   # one Telegram message
```

Keep it at one replica with `Recreate`, because two watchers would each send
every alert. Delivery is at-least-once: state is saved only after Telegram
accepts the message, so an outage delays an alert and never drops it. A crash
in the gap between the send and the save sends it twice.
