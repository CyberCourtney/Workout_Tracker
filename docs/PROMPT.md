# Build your own workout tracker with Claude Code

This app was built with [Claude Code](https://claude.com/claude-code) from
four prompts: one that builds the whole thing, a second that adds a
custom domain, a shareable workout image and a few extras, a third for a
landing page and colourful redesign, and a fourth that lets a few friends
train together. They're below
exactly as I used them, with my personal details swapped for
placeholders.

## Before you start

You'll need:

- An AWS account and the AWS CLI v2, signed in with a profile
  (`aws sso login --profile <your-profile>` if you use SSO).
- Python 3.12 and `zip` for the tests and the deploy script.
- An empty folder for the project, opened in Claude Code.
- For prompt 2 only: a domain with a Route 53 hosted zone.

Fill in every `[PLACEHOLDER]` before you paste. Nothing in the prompts
lets Claude change your AWS account on its own: it has to show you each
deploy command and wait for you to approve it, and you create your own
login yourself so your password never goes near it.

| Placeholder | What to put |
|---|---|
| `[AWS_REGION]` | Your AWS region, e.g. `eu-west-2` |
| `[AWS_PROFILE]` | Your AWS CLI profile name |
| `[REPO_URL]` | Your GitHub repo for the project |
| `[BRANCH]` | The branch the current code is on, e.g. `main` |
| `[PROJECT_FOLDER]` | The path to the project folder on your machine |
| `[STACK_NAME]` | Your CloudFormation stack name, e.g. `workout-tracker` |
| `[CLOUDFRONT_URL]` | The site URL printed by your first deploy |
| `[YOUR_DOMAIN]` | Your domain, e.g. `example.com` |
| `[APP_DOMAIN]` | Where the app should live, e.g. `workout.example.com` |
| `[YOUR_NAME]` | Your first name, shown as who to ask for an invite |
| `[ABOUT_YOU]` | A short description of yourself for the illustration, e.g. height, build, skin tone, hair |

---

## Prompt 1: build the app

Paste this into Claude Code in your empty project folder.

```text
<context>
You are building a personal workout tracker for one user, hosted in my AWS account. The architecture is serverless: S3 + CloudFront for the frontend, Cognito for login, API Gateway (HTTP API), Lambda, and DynamoDB for storage. Infrastructure MUST be defined in CloudFormation (not Terraform, not CDK, not SAM).
Region: [AWS_REGION]. AWS CLI profile: [AWS_PROFILE].
The project directory is currently empty.
</context>

<hard_constraints>
- Do not run any command that creates, changes or deletes AWS resources (including aws cloudformation deploy, aws s3 sync, and aws cognito-idp calls) until I explicitly approve that specific command in chat. Read-only checks such as aws sts get-caller-identity and cloudformation validate-template are allowed.
- No VPC, no NAT gateway, no provisioned capacity, and no always-on or paid-by-the-hour resources. The monthly cost for one user MUST stay close to zero. DynamoDB uses on-demand billing, and Lambda runs outside a VPC.
- Never write credentials, tokens, passwords or account IDs into source files. Do not create the Cognito user or handle my password. Give me the CLI command so I can do it myself.
- Do not install packages or add dependencies without asking. Use only the Python 3.12 standard library plus boto3 (already in the Lambda runtime), and vanilla HTML, CSS and JS in the frontend with no framework, no CDN and no external fonts.
- Do not touch files outside the project directory.
- Deliver what was asked. Do not add features beyond this spec.
</hard_constraints>

<task>
Build the app in this layout:
- infra/template.yaml: one CloudFormation template for all resources
- backend/handler.py: Lambda code
- backend/test_handler.py: unit tests using unittest and unittest.mock
- frontend/: index.html, styles.css, app.js, config.js
- scripts/deploy.sh: packages and deploys, with every step echoed first
- README.md: architecture summary, deploy steps, and the command to create my user
</task>

<infrastructure>
- DynamoDB: one on-demand table with PK (string) and SK (string), point-in-time recovery on, and DeletionPolicy: Retain.
- Item shape: PK = USER#<cognito sub>, SK = WORKOUT#<YYYY-MM-DD>#<id>. Each workout is one item: {id, date, status ("planned" | "completed"), exercises[] of {name, sets[] of {reps, weight}}, updatedAt}.
- Cognito user pool with self-sign-up DISABLED, a public app client using the authorization code flow with PKCE (no client secret), and a Hosted UI domain.
- API Gateway HTTP API with a JWT authorizer on the Cognito pool. CORS is limited to the CloudFront domain.
- Routes: GET /workouts?from=YYYY-MM-DD&to=YYYY-MM-DD, POST /workouts, PUT /workouts/{id}, DELETE /workouts/{id}. One Lambda function with least-privilege IAM, scoped to this table only. Every query MUST derive the user from the JWT sub claim, never from the request body or path.
- Private S3 bucket with CloudFront Origin Access Control, HTTPS only, and default root object index.html. No public bucket access.
- Outputs: CloudFront URL, API URL, user pool ID, app client ID, Hosted UI domain. The deploy script writes these into frontend/config.js.
</infrastructure>

<features>
1. Login: the site redirects to the Cognito Hosted UI when there is no valid session, and has a sign-out button.
2. Calendar: a month grid with previous, next and Today. A filled dot marks days with completed workouts, and a hollow dot marks days with planned workouts. Tapping a day lists its workouts. From any day, past or future, I can add a workout. Future dates save as "planned" and can be started, edited or deleted. Past dates save as "completed".
3. Start Workout: an always-visible button starts a workout dated today. I type each exercise name (with autocomplete from previous names), add sets with reps and weight, and can edit, delete and reorder. A Finish button saves it as completed. An unfinished draft MUST survive a page refresh (use localStorage for the draft only).
4. Progress: an inline SVG line chart with no chart library. An exercise dropdown selects what to plot, with one point per workout date. A metric toggle switches between Estimated 1RM (Epley), Total volume, and Top set weight, with Estimated 1RM as the default. Hover or tap shows the date and value. Show an empty state when there is no data. Compute from workouts fetched via the API.
5. History: I can browse any past month on the calendar and open any past workout, and the data persists across devices and sessions.
6. Settings: a kg/lb unit toggle (stored in localStorage, default kg).
</features>

<design>
The design MUST feel like an Apple product: the -apple-system / SF Pro font stack, large typography, generous whitespace, 12-20px rounded corners, soft shadows, a translucent navigation bar with backdrop-filter blur and three tabs (Calendar, Workout, Progress), automatic light and dark mode via CSS variables, one accent colour (#0A84FF), 150-250ms transitions that respect prefers-reduced-motion, a responsive layout, and 44px minimum tap targets.
</design>

<validation_rules>
Reject reps and weight values that are negative or non-numeric. Dates MUST match YYYY-MM-DD. Status MUST be "planned" or "completed". Limit request bodies to 100 KB and each workout to 30 exercises with 20 sets each. The Lambda returns clear 4xx errors and never leaks stack traces.
</validation_rules>

<success_criteria>
Done only when all of these are true. Report each as pass or fail with evidence:
1. cloudformation validate-template passes for infra/template.yaml (also run cfn-lint if it is already installed).
2. python -m unittest passes, covering create, read by date range, update, delete, validation failures, and one user being unable to read another user's items.
3. The template has no resource that costs money when idle.
4. The frontend contains no hardcoded AWS identifiers outside the generated config.js.
5. The README contains the exact deploy order and my create-user command.
After 1-5 pass, stop and show me the exact deploy commands and wait for my approval. After I approve and deploy, walk me through an end-to-end test: login, add a past workout, add a future workout, finish a new workout, refresh, and view the chart.
</success_criteria>

<working_method>
Plan briefly, then build in this order: CloudFormation template, Lambda and tests, frontend API layer and auth, calendar, workout logging, chart, styling.
Stop and ask before: adding any dependency, deleting any file, changing the data model after the first build, or running any AWS command that changes resources.
</working_method>
```

When it's done, Claude stops and shows you the deploy commands. Approve
them, run the create-user command from the README yourself, and follow
the end-to-end test it walks you through.

---

## Prompt 2: custom domain, share image and extras (optional)

Use this once the app from prompt 1 is deployed and working. It assumes
your domain is already in Route 53. If another site on that domain
already has a CloudFront distribution and certificate, Claude will look
at how it's set up (read-only) and reuse the same pattern.

```text
<context>
You are extending my existing personal workout tracker. It is already built and deployed, and you MUST work with what is there rather than rebuilding it.
- Repo: [REPO_URL] (branch [BRANCH]). Local folder: [PROJECT_FOLDER]
- AWS: profile [AWS_PROFILE], region [AWS_REGION], CloudFormation stack [STACK_NAME]. Live at [CLOUDFRONT_URL]
- Stack: CloudFormation only (infra/template.yaml), S3 + CloudFront with OAC, Cognito Hosted UI with PKCE, API Gateway HTTP API with a JWT authorizer, one Python 3.12 Lambda (backend/handler.py), DynamoDB on-demand (PK USER#<sub>, SK WORKOUT#<date>#<id>), vanilla HTML/CSS/JS frontend (frontend/), scripts/deploy.sh writes frontend/config.js.
- Design: Apple-style, SF font stack, accent #0A84FF, light and dark mode, three tabs (Calendar, Workout, Progress), 44px tap targets, phone-first.
- My domain is [YOUR_DOMAIN], hosted in Route 53. If another site is already served on it through CloudFront, reuse the same pattern for this app.
</context>

<hard_constraints>
- Do not run any command that creates, changes or deletes AWS resources (cloudformation deploy, s3 sync, route53 change-resource-record-sets, acm request-certificate, cognito-idp updates) until I approve that exact command in chat. Read-only describe, list and get calls are allowed and encouraged.
- Do not change the DynamoDB key schema or delete or rewrite existing workout items. New optional fields on a workout item are allowed only if older items still load correctly.
- No new paid-when-idle resources. Monthly cost MUST stay close to zero.
- No new dependencies, no framework, no CDN, no external fonts. Frontend stays vanilla JS; backend stays standard library plus boto3.
- Never write credentials, tokens or account IDs into source files.
- Only touch files inside the project folder. Work on a new branch named feature/domain-and-share and open a PR; do not push to main.
- Stop and ask before deleting any file or adding any feature not listed below.
</hard_constraints>

<task_1_custom_domain>
Serve the app at https://[APP_DOMAIN] (if an existing setup on [YOUR_DOMAIN] suggests a different naming convention, propose it before building).
1. First, inspect read-only how the domain is wired: find the Route 53 hosted zone for [YOUR_DOMAIN], any ACM certificate an existing CloudFront distribution on it uses (and whether it is a wildcard in us-east-1), and how its DNS records point at CloudFront. Report what you found in 5 lines or fewer before changing anything.
2. Reuse an existing wildcard certificate if one covers [APP_DOMAIN]. Otherwise add the smallest change needed to get a DNS-validated certificate in us-east-1 (CloudFront requires us-east-1), and explain how it is deployed given the main stack is in [AWS_REGION].
3. Add the alias and certificate to the CloudFront distribution, an A and AAAA alias record in Route 53, the new domain in the Cognito app client callback and sign-out URLs, and the new origin in the API CORS settings. Keep the old cloudfront.net URL working.
4. Make all of this parameterised in infra/template.yaml (DomainName, HostedZoneId, CertificateArn) so nothing is hardcoded, and update deploy.sh and README.md.
</task_1_custom_domain>

<task_2_share_image>
Add a Share button to every completed workout (in the day view and right after Finish).
- Generate the image entirely in the browser with the Canvas API. No server rendering, no libraries.
- Format: PNG, 1080 x 1350 (4:5 portrait), rendered at that pixel size regardless of screen DPR. It suits Instagram feed, Stories and messaging apps.
- Layout, top to bottom: app wordmark and date (e.g. "Sat 1 Nov 2026"); a headline stats row of three tiles (total volume, total sets, exercise count); one block per exercise with its name and each set as "reps x weight unit"; any personal record set from this workout marked with a small "PR" badge; a footer with [APP_DOMAIN].
- Style MUST match the app: SF font stack, #0A84FF accent, rounded 20px cards, dark background version by default. Respect the user's kg/lb setting.
- If the workout is too long to fit, scale text down to a readable minimum, then show the first exercises and a "+N more exercises" line. Never clip text mid-line.
- Sharing: use navigator.share with files when navigator.canShare({files}) is true (iOS Safari, Android Chrome). Otherwise fall back to downloading the PNG. Show a preview sheet with Share and Save buttons before sharing.
</task_2_share_image>

<task_3_bonus>
Add these four, and nothing else:
1. Personal records: detect a new best estimated 1RM or top weight per exercise when a workout is finished, show a small celebration toast, and reuse the same detection for the PR badge in the share image. Compute from existing data on the client; no schema change.
2. "Last time" hint: when I type an exercise name, show the sets from the most recent previous workout with that exercise under the input, so I know what to beat.
3. Repeat workout: a "Repeat" action on any past workout that copies its exercises (without weights logged as done) into a new draft for today.
4. Install as an app: add manifest.webmanifest, app icons generated as simple SVG/PNG in the repo, apple-touch-icon and theme-color meta tags so it can be added to the iPhone home screen and opens full screen. No service worker offline caching.
</task_3_bonus>

<success_criteria>
Report each as pass or fail with evidence:
1. aws cloudformation validate-template passes (and cfn-lint if already installed).
2. python -m unittest passes, including any new backend tests.
3. A test or script shows the share image renders at exactly 1080x1350 for a short workout and for a 30-exercise workout without clipped text. Save both sample PNGs to docs/share-samples/ and describe them.
4. Old workouts created before this change still load, chart and share correctly.
5. No hardcoded domain, ARN, hosted zone ID or account ID outside parameters and the generated config.js.
6. README lists the exact deploy order, including the certificate step.
After 1-6 pass, stop, open the PR, show me the exact AWS commands in order, and wait for approval. After I deploy, walk me through checking: the new domain loads with a valid certificate, login and logout redirect to the new domain, share works on my iPhone, and the old URL still works.
</success_criteria>

<working_method>
Order: read-only investigation of the existing domain setup, then domain infrastructure, then share image, then bonus features one at a time, committing after each. Keep each change to what that step needs.
</working_method>
```

## Prompt 3: landing page and colourful redesign (optional)

Use this once the app is deployed. It replaces the plain look with a bold,
colourful design and puts a landing page in front of the login. It only
touches the frontend.

```text
<context>
You are redesigning the front end of my existing personal workout tracker. It is already built and deployed. Work with what is there and keep every existing feature working.
- Repo: [REPO_URL]. Local folder: [PROJECT_FOLDER]
- AWS: profile [AWS_PROFILE], region [AWS_REGION], CloudFormation stack [STACK_NAME].
- Stack: S3 + CloudFront, Cognito Hosted UI (PKCE, self-sign-up disabled), API Gateway HTTP API, Python Lambda, DynamoDB. Vanilla HTML/CSS/JS frontend in frontend/ (index.html, styles.css, app.js, config.js). config.js is generated by scripts/deploy.sh.
- Current look: Apple-style, mostly monochrome with one blue accent (#0A84FF). This is being replaced.
- Audience: only me and a few friends. Today anyone opening the site is sent straight to the Cognito login screen. That is a bad first impression, so add a landing page in front of it.
</context>

<hard_constraints>
- Frontend only. Do not change infra/template.yaml, backend/, the DynamoDB data model, or the Cognito callback URLs. If you find a change there is unavoidable, stop and ask first.
- Do not run any command that changes AWS resources, including aws s3 sync and scripts/deploy.sh, until I approve that exact command in chat.
- No frameworks, no build step, no CDN, no external fonts, no stock photos and no remote images. All artwork MUST be original inline SVG or SVG files in frontend/assets/, made by you. Do not copy or trace artwork from the reference links.
- Do not add packages or dependencies without asking. Do not delete files without asking.
- Every existing feature MUST still work: login and logout, calendar, start/finish workout with the localStorage draft, progress chart, kg/lb toggle, and anything else already in app.js.
- Work on a new branch named feature/landing-and-colour and open a PR. Do not push to main.
</hard_constraints>

<design_direction>
Mood: bold, colourful, energetic and friendly, like a modern fitness app marketing site.
- Palette (CSS variables in :root, used everywhere): deep navy #0F1024 for dark surfaces, off-white #F7F7FB for light surfaces, electric violet #6C5CE7 primary, energy colours coral #FF6B6B, mango #FFB547, lime #B8F23A, sky #2EC5FF. Gradients: violet to sky for primary actions and the hero; coral to mango for PRs and celebrations.
- Each feature has its own colour: Calendar = sky, Workout = coral, Progress = lime, Share/PRs = mango.
- Shapes: 24px rounded cards, soft coloured shadows, floating blurred gradient blobs behind key sections, a slight "3D" feel from layered gradients. No real 3D or WebGL.
- Type: system font stack. Large, heavy headlines (800 weight, 40-56px on mobile for the hero) and readable 16-17px body.
- Motion: fade/slide-ups on scroll with IntersectionObserver, a gentle float on the hero art, button press feedback. 150-400ms, all off under prefers-reduced-motion.
- Phone-first at 375px, scaling to 1440px. 44px minimum tap targets. Body text contrast MUST meet WCAG AA (4.5:1) on every coloured background.
- Light and dark mode both MUST look intentional. Default to dark.
</design_direction>

<illustration>
Draw one original flat 2D vector character in inline SVG for the hero, and reuse it in up to two more spots (e.g. empty states).
- It represents me: [ABOUT_YOU]
- Colourful gym kit in the palette colours, in an active pose (e.g. holding a dumbbell, or stepping forward with a phone showing the app).
- Clean flat shapes with simple shading, no outlines. Each SVG under 30 KB.
</illustration>

<task_1_landing_page>
- When there is no valid session, show the landing page instead of redirecting to Cognito. "Sign in" buttons start the existing Hosted UI login.
- When a valid session exists, or the URL contains the Cognito ?code= callback, skip the landing page and open the app.
- Keep the callback URL unchanged; explain where you put the landing page in one sentence.
Sections, in order:
1. Hero: app name, a punchy headline and one-line subhead in a warm, encouraging tone focused on self-improvement and wellbeing (no trash talk, no body-shaming or "no excuses" language), the illustrated character, a CSS/SVG phone mockup of an app screen, and a gradient "Sign in" button.
2. Features: four colour-coded cards (Log as you go, Calendar history, Progress charts, Share your session), each with a small custom SVG icon and one sentence.
3. How it works: three numbered steps (Start a workout, Add sets as you go, Watch the line go up).
4. App preview: two or three HTML/CSS phone mockups with sample data, in a horizontal scroll-snap row on mobile.
5. Closing call to action: "Ready to train?" with Sign in and a small line: "Invite only. Ask [YOUR_NAME] for an account."
6. Footer: app name and year.
No pricing, testimonials, app store badges, newsletter forms or analytics.
</task_1_landing_page>

<task_2_restyle_app>
Apply the same design system to the signed-in app, keeping all behaviour:
- Tab bar: each tab tinted with its feature colour when active.
- Calendar: sky accents, coloured dots for completed (filled) and planned (outlined), today with a gradient ring.
- Workout: coral accents, colourful set rows, a big gradient Finish button, and a CSS/SVG confetti burst on Finish.
- Progress: lime line with a soft gradient fill, coloured metric toggle pills.
- Empty states: the character with a friendly line of copy.
- Settings and dialogs: match the new cards, buttons and inputs. Update the share image colours too.
</task_2_restyle_app>

<success_criteria>
Report each as pass or fail with evidence:
1. No session shows the landing page; Sign in goes to Cognito; after login the app loads directly; a refresh while signed in skips the landing page.
2. Every existing feature still works, and python -m unittest still passes.
3. No external requests: no http(s) URLs in frontend/ other than those built from config.js.
4. Screenshots at 375px and 1440px of the landing page and each tab, light and dark, in docs/screenshots/.
5. A list of text/background colour pairs with contrast ratios; all body text 4.5:1 or higher.
6. With prefers-reduced-motion, no animation runs.
After 1-6 pass, open the PR, show me the screenshots and the exact deploy command, and wait for my approval.
</success_criteria>
```

## Prompt 4: crew (friends training together, optional)

Adds a social layer for a small group: shared goals, friendly
challenges and comparing progress on the chart. It changes the data
model, so the prompt makes Claude write a design first and wait for your
approval before coding.

One thing Claude found while building this: Cognito's hosted sign-up
page can't collect an invite code, so it added a small "Have an invite?"
form to the landing page that calls Cognito's sign-up API instead. The
invite-code check itself works exactly as the prompt describes.

```text
<context>
You are adding a social layer to my existing personal workout tracker so a small group of my friends can train "together": shared goals, friendly competitions, and comparing progress on the chart. Fewer than 15 people will ever use it.
- Repo: [REPO_URL]. Local folder: [PROJECT_FOLDER]
- AWS: profile [AWS_PROFILE], region [AWS_REGION], CloudFormation stack [STACK_NAME] (infra/template.yaml).
- Stack: S3 + CloudFront, Cognito Hosted UI (PKCE, self-sign-up currently DISABLED), API Gateway HTTP API with a JWT authorizer, one Python 3.12 Lambda (backend/handler.py, tests in backend/test_handler.py), one DynamoDB on-demand table (PK/SK strings). Vanilla HTML/CSS/JS frontend in frontend/.
- Existing items: PK = USER#<cognito sub>, SK = WORKOUT#<YYYY-MM-DD>#<id>, holding {id, date, status, exercises[{name, sets[{reps, weight}]}], updatedAt}. Every query derives the user from the JWT sub. That rule MUST stay true for a user's own data.
- Design: colourful system on CSS variables. Navy #0F1024, violet #6C5CE7, coral #FF6B6B, mango #FFB547, lime #B8F23A, sky #2EC5FF. Dark mode is the default.
- The progress chart is a hand-written inline SVG line chart with an exercise dropdown and a metric toggle: Estimated 1RM (Epley, default), Total volume and Top set weight.
</context>

<decisions_already_made>
1. Logins: every friend gets their own Cognito login. Enable self-sign-up, protected by an invite code: a Cognito Pre sign-up Lambda trigger rejects any sign-up whose invite code does not match. The code is a CloudFormation NoEcho parameter, never in source. Email verification stays on.
2. One crew: everyone with an account is in the same crew. No multiple groups, no friend requests.
3. Privacy: each user has a "Share my progress with the crew" setting, on by default. Friends never see each other's raw workouts, sets or notes; only display name, colour, aggregated chart series, goal progress and competition standings.
4. Profiles: on first login, ask for a display name. The app assigns a person colour that the user can change in Settings.
5. Tone: self-improvement and wellbeing, not beating each other. All copy warm and supportive; no trash talk, taunts or shaming, and never draw attention to whoever is last. Competitions measure progress against each person's own starting point; leaderboards say things like "Biggest improvers". Members can send a one-tap "cheer" that appears in a crew feed.
</decisions_already_made>

<task_0_design_first>
Before writing any code, write docs/SOCIAL_DESIGN.md in 60 lines or fewer with: the new DynamoDB item types (additive, same table, no change to existing items or the key schema); new API routes with request/response shapes and exactly how each stops a user reading another user's raw workouts or a non-sharing member's data; how crew series are computed server-side and why that's fine at fewer than 15 users; the Cognito changes and the exact friend sign-up flow; any cost impact (must stay close to zero). Then STOP and wait for my approval.
</task_0_design_first>

<task_1_goals>
Goal types: hit a weight on an exercise, reach an estimated 1RM, workouts per week, and total volume over a date range. Each has a target, an optional deadline and live progress shown as a ring in the person's colour. A Crew screen lists every sharing member's active goals. When a goal is hit, celebrate and post it to the crew feed.
</task_1_goals>

<task_2_competitions>
Any member can create a competition with a name, start and end dates and one metric: most workouts, most total volume, biggest % improvement in estimated 1RM on a chosen exercise (the default, fairest across strength levels), or longest streak of weeks hitting a workouts-per-week target. Others join with one tap. Show a supportively titled live leaderboard with rank, avatar dot in the person's colour, name, score and a podium for the top 3. Lock results when it ends and keep past competitions viewable. Only sharing members can join.
</task_2_competitions>

<task_3_chart_compare>
Add a "Me | Crew" toggle to the Progress chart. Crew mode plots one line per sharing member for the chosen exercise and metric, with chips to pick who's shown (default: me plus up to 3 others), and a "% change from start" view as the default. Identification MUST NOT depend on colour alone: each person gets a fixed colour from #B8F23A, #2EC5FF, #FF6B6B, #FFB547, #C084FC, #FF5FA2, #20D6A5, #F4F4F8 (in sign-up order, user-changeable), a distinct marker shape, and a direct name label at the end of their line. My line is 3px and on top; others 2px at 85% opacity. Tapping highlights a person and fades the others. The tooltip lists every visible person's value for that date, in their colour.
</task_3_chart_compare>

<hard_constraints>
- Do not run any command that creates, changes or deletes AWS resources until I approve that exact command in chat.
- Do not modify or migrate existing workout items. All new data is additive.
- A user's own workouts can only be read or written using their JWT sub. Crew endpoints return aggregates only and MUST exclude members with sharing off.
- No new paid-when-idle resources, no VPC, DynamoDB stays on-demand. No new dependencies; backend uses the standard library plus boto3; frontend stays vanilla JS.
- Never write the invite code, credentials or account IDs into source files.
- Work on branch feature/crew and open a PR. Commit after each task.
</hard_constraints>

<success_criteria>
1. validate-template passes.
2. python -m unittest passes, with new tests proving: user A can't read user B's workouts through any route; crew endpoints exclude non-sharing users and never return sets, reps or notes; the pre-sign-up trigger rejects a wrong or missing code; goal progress and each competition metric are computed correctly.
3. Existing workouts and the solo chart behave exactly as before.
4. Crew chart screenshots at 375px with 1, 4 and 8 people in docs/screenshots/crew/, every line identifiable without colour.
5. README covers friend sign-up, setting or rotating the invite code, and the deploy order.
After 1-5 pass, open the PR, show me the exact deploy commands in order and wait for my approval. After deploy, walk me through a two-account test.
</success_criteria>
```

## Tips from building it

- **Keep the "ask before AWS changes" rule.** It means you see every
  command before it touches your account, and it's the reason the whole
  thing can be trusted to run in a real account.
- **Let it stop at the success criteria.** Asking for pass or fail with
  evidence gets you real test output, not "should work".
- **Create the login yourself.** The prompts deliberately hand you the
  `aws cognito-idp admin-create-user` command instead of running it, so
  your password is only ever typed into the Cognito sign-in page.
