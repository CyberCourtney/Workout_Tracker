# Crew design (for approval)

**Rule:** a user's own items are only read or written under `USER#<jwt sub>`. Crew routes return numbers and names only, never sets, reps or notes, and they filter out non-sharing members *before* anything else is read. Existing `WORKOUT#` items and the key schema don't change.

## New items (same table, additive)
| PK | SK | Attributes | Access pattern |
|---|---|---|---|
| `CREW` | `MEMBER#<sub>` | `memberId` (random, public), `displayName`, `colour`, `shape`, `sharing` (bool, default true), `joinedAt` | One Query lists the whole crew. Own profile = GetItem on own sub. |
| `USER#<sub>` | `GOAL#<id>` | `type` (weight / e1rm / perWeek / volume), `exercise?`, `target`, `startDate`, `deadline?`, `endDate?` (volume), `status` (active/completed), `completedAt?` | Own goals: Query `begins_with GOAL#` |
| `CREW` | `COMP#<id>` | `name`, `metric` (e1rmPct, the default / workouts / volume / streak), `exercise?`, `weeklyTarget?`, `startDate`, `endDate`, `createdBy` (memberId), `participants` (set of subs), `result?` (locked standings) | List: Query `begins_with COMP#` |
| `CREW` | `FEED#<iso ts>#<id>` | `kind` (goalDone / cheer / compCreated / compJoined / compFinished), `actor`, `subject?` (memberIds), `ref`, `text`, `expiresAt` (TTL, 90 days) | Latest 30: Query `begins_with FEED#`, newest first |

Why `CREW/MEMBER#` instead of `USER#<sub>/PROFILE`: profile fields are crew-visible anyway, so keeping a single copy under `CREW` lets the whole crew be listed in one Query, with nothing to keep in sync. Subs never leave the server. Other people are referred to by a random `memberId`.

## Routes (all behind the existing Cognito JWT authorizer; caller = JWT `sub`)
| Route | Request → response | Isolation |
|---|---|---|
| `GET /me`, `PUT /me` | `{displayName, colour, sharing}` → own profile (404 until first set-up) | Key built from JWT sub only. Colour must be unused (any colour once all 8 are taken). |
| `GET/POST /goals`, `PUT/DELETE /goals/{id}` | goal fields → goal + `progress {value, target, pct}` | Own partition only, so the same rule as workouts applies |
| `GET /crew` | → `{me, members[{memberId,displayName,colour,shape}], goals[{memberId,label,target,value,progressPct,deadline,status}], feed[], exerciseNames[]}` | `members` filtered to `sharing=true` (the caller is always included). Goals are read only for those members. Whitelisted response fields. |
| `GET /crew/series?exercise=&metric=` | → `{series[{memberId,displayName,colour,shape,points[{date,value}]}]}` | Sharing members only. Their workouts are reduced in the Lambda to one number per date. Members with no data for the exercise are omitted. |
| `POST /crew/cheers` | `{memberId, ref}` → 201 | Target must be sharing. Writes only a feed item. |
| `GET /competitions`, `POST /competitions`, `POST /competitions/{id}/join` | comp fields → `{comps[{…, standings[{rank,memberId,displayName,colour,score}]}]}` | Join needs `sharing=true`. Standings are computed from aggregates and drop anyone not sharing, even in locked results. |

Every crew response passes through one serializer that only copies whitelisted keys. Tests also scan the JSON for `sets`, `reps`, `notes` and `weight` arrays.

## Computing crew data
Crew routes Query each sharing member's `WORKOUT#` partition inside the Lambda (at most 15 Queries, each typically under 50 KB) and reduce it to daily numbers: e1RM (Epley), volume or top set. These reuse the progress chart's rules. Goal progress and competition scores use the same functions. "% change from start" is worked out in the browser from those points. At under 15 users that's tens of milliseconds and a few hundred read units per crew view, so no fan-out tables or precomputation are needed. Results lock at the first read after `endDate`, using a conditional write (`attribute_not_exists(result)`).

Competition scores: workouts = completed sessions in the range. Volume = Σ reps×weight. e1rmPct = best e1RM in the range ÷ best e1RM before the start − 1 (no baseline means the first week is the baseline). Streak = the longest run of Mon–Sun weeks that meet `weeklyTarget`. Only ranks are shown, with no "last place" styling, under the title "Biggest improvers" / "Most consistent".

## Cognito + friend sign-up
- **Blocker found:** the Hosted UI sign-up page can't collect an invite code (no custom fields, no client metadata). Instead, the landing page gets a small "Have an invite?" form. It calls Cognito's public `SignUp` API (no secret needed for this public client) with `ValidationData.inviteCode`, then `ConfirmSignUp` with the emailed code. After that the friend signs in through the existing Hosted UI as normal.
- Template: `AllowAdminCreateUserOnly: false`. A new `InviteCode` parameter (`NoEcho`, at least 12 characters). A new tiny Pre sign-up Lambda (inline code, logs only) that compares the code in constant time and rejects anything wrong or missing. That includes sign-ups from the Hosted UI's own "Sign up" link, which send no code.
- Email verification stays on. Existing users are unaffected.
- Rotating the code means redeploying with a new `InviteCode` value. Codes already used don't matter.
- Flow: friend opens the site → "Have an invite?" → email, password, invite code → enters the 6-digit email code → Sign in → first login asks for a display name and assigns the first free colour.

## Other template changes
New API routes; the API Lambda gets `GetItem` and `UpdateItem` on the same table; DynamoDB TTL is turned on for `expiresAt`.

## Cost
Nothing new is billed while idle. The Pre sign-up Lambda runs only when someone signs up. TTL deletes are free. Extra reads cost fractions of a penny a month at this scale. Cognito Lite is free under 10,000 monthly users.
