# Workout Tracker

A personal, phone-first workout tracker hosted in your own AWS account. Log workouts as you go, plan future ones on a calendar, and see your progress per exercise on a line chart.

## Architecture

```
Phone browser
   │  HTTPS
   ├──► CloudFront ──(Origin Access Control)──► private S3 bucket  (index.html, styles.css, app.js, config.js)
   ├──► Cognito Hosted UI  (sign-in, authorization code + PKCE, self sign-up disabled)
   └──► API Gateway HTTP API ──(JWT authorizer: Cognito)──► Lambda (Python 3.12) ──► DynamoDB (on-demand)
```

| Piece | What it does | Idle cost |
|---|---|---|
| S3 + CloudFront | Serves the static frontend. Bucket is private; only CloudFront can read it. HTTPS only. | ~$0 (pennies of storage) |
| Cognito user pool (Lite tier) | Login via the Hosted UI. Only users you create can sign in. | $0 (free under 10,000 monthly users) |
| HTTP API + JWT authorizer | Routes below; rejects requests without a valid Cognito access token. CORS allows only the CloudFront domain. Throttled to 10 req/s. | $0 when idle, pay per request |
| Lambda (`backend/handler.py`) | Validates input and reads/writes the table. User is always the JWT `sub`. IAM allows only Query/PutItem/DeleteItem on this one table. | $0 when idle |
| DynamoDB | One on-demand table, point-in-time recovery on, retained if the stack is deleted. | ~$0 (pennies of storage + PITR) |
| CloudWatch Logs | Lambda logs, kept 14 days. | ~$0 |
| ACM certificate (optional, us-east-1) | TLS for the custom domain. | $0 |

No VPC, NAT gateway, provisioned capacity or anything billed by the hour.

### Data model

One item per workout:

- `PK` = `USER#<cognito sub>`
- `SK` = `WORKOUT#<YYYY-MM-DD>#<id>`
- attributes: `id`, `date`, `status` (`planned` | `completed`), `exercises[]` of `{name, sets[] of {reps, weight}}`, `updatedAt`

Weights are stored in kg. The kg/lb setting only changes what the app displays.

### API

| Route | Notes |
|---|---|
| `GET /workouts?from=YYYY-MM-DD&to=YYYY-MM-DD` | Inclusive date range, both required |
| `POST /workouts` | Creates a workout; the server assigns the id |
| `PUT /workouts/{id}` | Replaces a workout (can move its date, e.g. starting a planned workout today) |
| `DELETE /workouts/{id}` | |

Validation: dates must be real `YYYY-MM-DD` dates, status must be `planned` or `completed`, reps and weight must be non-negative numbers, at most 30 exercises with 20 sets each, bodies at most 100 KB. Errors return a 4xx with `{"error": "..."}`; unexpected errors return a generic 500 and are logged, never echoed.

## Project layout

```
infra/template.yaml        CloudFormation for every resource
backend/handler.py         Lambda function
backend/test_handler.py    Unit tests (unittest + unittest.mock)
infra/certificate.yaml     ACM certificate for the custom domain (us-east-1)
frontend/                  index.html, styles.css, app.js, share.js, config.js (generated), manifest + icons
scripts/deploy.sh          Validates, deploys, uploads code and site; echoes every command
scripts/deploy-certificate.sh  Creates the us-east-1 certificate and prints its DNS validation record
tests/share-render.html    Browser test for the share image
docs/share-samples/        Sample share images
```

## Features

- **Calendar**: month grid; filled dot = completed, hollow dot = planned. Tap a day to see, add, edit, delete, start, share or repeat its workouts.
- **Workout**: type exercises as you go, with autocomplete and a "Last time" line under each exercise showing what you did before. The draft survives a refresh.
- **Progress**: line chart per exercise (estimated 1RM, volume or top set).
- **Personal records**: when you finish, any set that beats your previous best estimated 1RM or top weight for that exercise gets a 🏆 toast. Worked out on the phone from your history; nothing extra is stored.
- **Share**: any completed workout (and the "Workout saved" sheet after Finish) can be shared as a 1080×1350 PNG drawn in the browser with the Canvas API. It opens the iPhone share sheet, or saves the file where sharing isn't available. PR sets get a "PR" badge.
- **Repeat**: copies a past workout's exercises into a new draft for today. Last time's numbers show as greyed placeholders, so nothing counts until you type it.

## Run the tests

```bash
cd backend && python3 -m unittest -v
```

Share image: serve the repo root (`python3 -m http.server`) and open `/tests/share-render.html`. It renders a short workout, a 30-exercise workout and the API's worst case (30 exercises × 20 sets), and checks each is exactly 1080×1350 with no text outside its box. The page title reads PASS or FAIL. Sample output is in `docs/share-samples/`.

## Deploy

Prerequisites: AWS CLI v2 signed in to the account you want to use, and `zip`.

### First deploy (cloudfront.net URL only)

`scripts/deploy.sh` runs these in order, printing each command first:

1. `aws sts get-caller-identity`: confirm which account you're about to deploy to.
2. `aws cloudformation validate-template --template-body file://infra/template.yaml`
3. `aws cloudformation deploy --stack-name workout-tracker --template-file infra/template.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset [--parameter-overrides ...]` (first run takes about 5 minutes, mostly CloudFront)
4. `aws cloudformation describe-stacks` to read the outputs (site URL, API URL, user pool ID, client ID, Hosted UI domain, bucket, distribution, function).
5. Zip `backend/handler.py` and `aws lambda update-function-code`, then `aws lambda wait function-updated`.
6. Write the outputs into `frontend/config.js`.
7. `aws s3 sync frontend/ s3://<bucket>/ --delete`, `aws s3 cp` for `manifest.webmanifest` (sets its content type), then `aws cloudfront create-invalidation --paths "/*"`.

```bash
aws sso login --profile <your-profile>        # only if your profile uses SSO
AWS_PROFILE=<your-profile> AWS_REGION=eu-west-2 ./scripts/deploy.sh
```

After a deploy, `frontend/config.js` contains that deployment's IDs. Don't commit it; `git checkout frontend/config.js` restores the blank version.

### Custom domain (e.g. workout.example.com)

CloudFront only accepts certificates from **us-east-1**, while the app stack lives in eu-west-2. So the certificate is a separate tiny stack (`infra/certificate.yaml`, an ACM certificate, free) deployed to us-east-1, and its ARN is passed to the main stack as a parameter. The main stack then adds the domain as a CloudFront alias, adds it to the Cognito callback and sign-out URLs and the API's CORS origins, and keeps the cloudfront.net URL working.

Deploy order:

1. **Certificate (us-east-1).**
   ```bash
   AWS_PROFILE=<your-profile> DOMAIN_NAME=workout.example.com ./scripts/deploy-certificate.sh
   ```
   This runs `aws cloudformation validate-template` and `aws cloudformation create-stack --region us-east-1 --stack-name workout-tracker-certificate ...`, then prints a **validation CNAME**. If your DNS isn't in Route 53 (e.g. Cloudflare), add that CNAME at your DNS provider now, set to *DNS only* (not proxied), and leave it there permanently so the certificate renews itself. The script waits (`aws cloudformation wait stack-create-complete`) until ACM sees the record, usually a few minutes, then prints `CERTIFICATE_ARN=...`. With a Route 53 zone, add `HOSTED_ZONE_ID=<zone id>` and validation is automatic.
2. **App stack with the domain.**
   ```bash
   AWS_PROFILE=<your-profile> DOMAIN_NAME=workout.example.com CERTIFICATE_ARN=<arn from step 1> ./scripts/deploy.sh
   ```
   Add `HOSTED_ZONE_ID=<zone id>` only if the domain's DNS is in Route 53; the stack then creates A and AAAA alias records itself.
3. **Site DNS record** (DNS outside Route 53 only). At your DNS provider add a CNAME from the domain to the `DnsTarget` value the deploy prints (the `xxxx.cloudfront.net` name), *DNS only*.

Later plain `./scripts/deploy.sh` runs keep the domain: parameters you don't set keep the stack's current values.

## Create your login

Self sign-up is disabled, so create your own user once after the first deploy. Use the `UserPoolId` printed at the end of the deploy:

```bash
aws cognito-idp admin-create-user \
  --profile <your-profile> --region eu-west-2 \
  --user-pool-id <UserPoolId> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Cognito emails you a temporary password. Open the site URL, sign in with it, and the Hosted UI asks you to choose your real password (at least 12 characters, with upper case, lower case and a number). Your password never goes through the terminal or this code.

On iPhone, open the site in Safari and use Share → Add to Home Screen. It gets the app icon and opens full screen (`manifest.webmanifest`, `icon-*.png`, rendered from `frontend/icon.svg`). There is no offline caching.

## Tear down

```bash
aws cloudformation delete-stack --stack-name workout-tracker --profile <your-profile> --region eu-west-2
```

The DynamoDB table is kept (DeletionPolicy: Retain) so your history survives; delete it by hand in the console if you really want it gone. The S3 bucket must be emptied before the stack can delete it.
