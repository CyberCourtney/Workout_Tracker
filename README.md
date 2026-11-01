# Workout Tracker

I'm on a fat loss journey. Anyone who's done one knows the scales are a
pretty miserable way to measure it: they bounce around day to day, and
some weeks they barely move even when everything else is going right.
What I actually wanted to see was the stuff that *was* changing. Am I
lifting more than I was a month ago? Am I turning up as often as I
think I am? Is the work adding up?

My workouts were scattered across notes on my phone, half-remembered
numbers and the odd screenshot. There was no way to look back and see
progress, and no easy way to plan the week ahead either. The apps I
tried were either cluttered, wanted a subscription, or wanted all my
data on someone else's servers.

So I built my own. It's a small, phone-first web app that does exactly
three things:

- **Calendar:** see which days I trained (a filled dot) and which I've
  planned (a hollow dot), plan future sessions, and open any past one.
- **Workout:** a big Start Workout button for the gym. Type each
  exercise, add sets with reps and weight, hit Finish. If my phone locks
  or the page refreshes mid-session, the draft is still there.
- **Progress:** a chart per exercise, showing estimated one-rep max,
  total volume or top set weight over time. This is the bit that keeps
  me going on the weeks the scales don't.

**It's also another hands-on AWS project.** I'm building my cloud skills
by making real things I actually use, and a workout tracker for one
person is a nice problem to get right: it needs a proper login, it has
to keep my data safe and private, and it should cost close to nothing
to run, because it sits idle for most of the day. That's why it's fully
serverless with on-demand billing, why login is Cognito rather than
something homemade, and why every piece of infrastructure lives in one
CloudFormation template.

## Build your own

I built this with Claude Code from a single detailed prompt, then
extended it with a second one. Both are in
**[docs/PROMPT.md](docs/PROMPT.md)**, with my personal details swapped
out for placeholders, so you can paste them into Claude Code and build
your own copy in your own AWS account.

## Skills demonstrated

**AWS:** CloudFormation · Cognito (Hosted UI, authorization code + PKCE) ·
API Gateway HTTP API (JWT authorizer) · Lambda · DynamoDB · S3 ·
CloudFront (Origin Access Control) · IAM (least privilege)

**Practices:** infrastructure as code, least-privilege IAM scoped to one
table, the user always taken from the verified JWT and never from the
request, input validation with clear 4xx errors and no leaked stack
traces, unit tests including a check that one user can't read another
user's data, and a design that costs close to zero when idle.

**Frontend:** vanilla HTML, CSS and JavaScript with no framework, no
libraries and no CDN. The chart is hand-drawn inline SVG. Light and dark
mode follow the phone's setting.

## How it works

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
frontend/                  index.html, styles.css, app.js, config.js (config.js is generated by the deploy script)
scripts/deploy.sh          Validates, deploys, uploads code and site; echoes every command
```

## Run the tests

```bash
cd backend && python3 -m unittest -v
```

## Deploy

Prerequisites: AWS CLI v2 signed in to the account you want to use, and `zip`.

Deploy order (this is exactly what `scripts/deploy.sh` does, printing each command before it runs):

1. `aws sts get-caller-identity`: confirm which account you're about to deploy to.
2. `aws cloudformation validate-template --template-body file://infra/template.yaml`
3. `aws cloudformation deploy --stack-name workout-tracker --template-file infra/template.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset` (first run takes about 5 minutes, mostly CloudFront)
4. `aws cloudformation describe-stacks` to read the outputs (site URL, API URL, user pool ID, client ID, Hosted UI domain, bucket, distribution, function).
5. Zip `backend/handler.py` and `aws lambda update-function-code`, then `aws lambda wait function-updated`.
6. Write the outputs into `frontend/config.js`.
7. `aws s3 sync frontend/ s3://<bucket>/ --delete`, then `aws cloudfront create-invalidation --paths "/*"`.

Run it:

```bash
aws sso login --profile <your-profile>        # only if your profile uses SSO
AWS_PROFILE=<your-profile> AWS_REGION=eu-west-2 ./scripts/deploy.sh
```

After a deploy, `frontend/config.js` contains that deployment's IDs. Don't commit it; `git checkout frontend/config.js` restores the blank version.

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

On iPhone, open the site in Safari and use Share → Add to Home Screen for an app-like icon.

## Tear down

```bash
aws cloudformation delete-stack --stack-name workout-tracker --profile <your-profile> --region eu-west-2
```

The DynamoDB table is kept (DeletionPolicy: Retain) so your history survives; delete it by hand in the console if you really want it gone. The S3 bucket must be emptied before the stack can delete it.
