"""Workout tracker API (API Gateway HTTP API, payload v2, JWT authorizer).

Routes:
  GET    /workouts?from=YYYY-MM-DD&to=YYYY-MM-DD
  POST   /workouts
  PUT    /workouts/{id}
  DELETE /workouts/{id}
  Crew (see docs/SOCIAL_DESIGN.md): /me, /goals, /crew, /crew/series,
  /crew/cheers, /competitions, /competitions/{id}/join

The user is always taken from the verified JWT `sub` claim, never from the
request. Items: PK = USER#<sub>, SK = WORKOUT#<YYYY-MM-DD>#<id> or GOAL#<id>;
crew-wide items live under PK = CREW. Crew responses carry aggregates only.
"""

import base64
import datetime
import json
import logging
import math
import os
import re
import uuid
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 100 * 1024
MAX_EXERCISES = 30
MAX_SETS = 20
MAX_NAME_LEN = 100
STATUSES = ("planned", "completed")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")

_table = None


def get_table():
    global _table
    if _table is None:
        import boto3  # available in the Lambda runtime

        _table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _table


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ------------------------------------------------------------------ helpers
def _json_default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"Unserializable {type(o).__name__}")


def respond(status, body=None):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": "" if body is None else json.dumps(body, default=_json_default),
    }


def user_pk(event):
    try:
        sub = event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
    except (KeyError, TypeError):
        raise ApiError(401, "Unauthorized")
    if not isinstance(sub, str) or not sub:
        raise ApiError(401, "Unauthorized")
    return f"USER#{sub}"


def valid_date(value, field="date"):
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ApiError(400, f"{field} must be YYYY-MM-DD")
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, f"{field} is not a real date")
    return value


def valid_number(value, field):
    # bool is a subclass of int; reject it explicitly.
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ApiError(400, f"{field} must be a number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ApiError(400, f"{field} must be a number")
    if isinstance(value, Decimal) and not value.is_finite():
        raise ApiError(400, f"{field} must be a number")
    if value < 0:
        raise ApiError(400, f"{field} must not be negative")
    if value > 100000:
        raise ApiError(400, f"{field} is too large")
    return Decimal(str(value))


def parse_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Body is not valid UTF-8")
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise ApiError(413, "Request body must be 100 KB or less")
    try:
        body = json.loads(raw, parse_float=Decimal)
    except json.JSONDecodeError:
        raise ApiError(400, "Body must be valid JSON")
    if not isinstance(body, dict):
        raise ApiError(400, "Body must be a JSON object")
    return body


def validate_workout(body):
    """Return a clean workout dict (only known fields) or raise ApiError(400)."""
    date = valid_date(body.get("date"))
    status = body.get("status")
    if status not in STATUSES:
        raise ApiError(400, 'status must be "planned" or "completed"')
    exercises = body.get("exercises")
    if not isinstance(exercises, list) or not exercises:
        raise ApiError(400, "exercises must be a non-empty list")
    if len(exercises) > MAX_EXERCISES:
        raise ApiError(400, f"A workout can have at most {MAX_EXERCISES} exercises")
    clean = []
    for i, ex in enumerate(exercises, 1):
        if not isinstance(ex, dict):
            raise ApiError(400, f"exercise {i} must be an object")
        name = ex.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ApiError(400, f"exercise {i} needs a name")
        if len(name.strip()) > MAX_NAME_LEN:
            raise ApiError(400, f"exercise {i} name is too long")
        sets = ex.get("sets", [])
        if not isinstance(sets, list):
            raise ApiError(400, f"exercise {i} sets must be a list")
        if len(sets) > MAX_SETS:
            raise ApiError(400, f"exercise {i} can have at most {MAX_SETS} sets")
        clean_sets = []
        for j, s in enumerate(sets, 1):
            if not isinstance(s, dict):
                raise ApiError(400, f"exercise {i} set {j} must be an object")
            clean_sets.append(
                {
                    "reps": valid_number(s.get("reps"), f"exercise {i} set {j} reps"),
                    "weight": valid_number(s.get("weight"), f"exercise {i} set {j} weight"),
                }
            )
        clean.append({"name": name.strip(), "sets": clean_sets})
    return {"date": date, "status": status, "exercises": clean}


def to_item(pk, workout_id, workout):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    return {
        "PK": pk,
        "SK": f"WORKOUT#{workout['date']}#{workout_id}",
        "id": workout_id,
        "date": workout["date"],
        "status": workout["status"],
        "exercises": workout["exercises"],
        "updatedAt": now,
    }


def public(item):
    return {k: item[k] for k in ("id", "date", "status", "exercises", "updatedAt") if k in item}


def query_all(**kwargs):
    table = get_table()
    items = []
    while True:
        res = table.query(**kwargs)
        items.extend(res.get("Items", []))
        if "LastEvaluatedKey" not in res:
            return items
        kwargs["ExclusiveStartKey"] = res["LastEvaluatedKey"]


def find_by_id(pk, workout_id):
    # The SK starts with the date, so look the id up within this user's
    # partition. One user's partition is small; this stays cheap.
    items = query_all(
        KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues={":pk": pk, ":prefix": "WORKOUT#"},
    )
    for item in items:
        if item.get("id") == workout_id:
            return item
    return None


def path_id(event):
    workout_id = (event.get("pathParameters") or {}).get("id")
    if not isinstance(workout_id, str) or not ID_RE.match(workout_id):
        raise ApiError(400, "Invalid workout id")
    return workout_id


# ------------------------------------------------------------------ routes
def list_workouts(event, pk):
    qs = event.get("queryStringParameters") or {}
    date_from = valid_date(qs.get("from"), "from")
    date_to = valid_date(qs.get("to"), "to")
    if date_from > date_to:
        raise ApiError(400, "from must be on or before to")
    items = query_all(
        KeyConditionExpression="PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues={
            ":pk": pk,
            ":lo": f"WORKOUT#{date_from}#",
            ":hi": f"WORKOUT#{date_to}#￿",
        },
    )
    return respond(200, {"items": [public(i) for i in items]})


def create_workout(event, pk):
    workout = validate_workout(parse_body(event))
    item = to_item(pk, str(uuid.uuid4()), workout)
    get_table().put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    return respond(201, public(item))


def update_workout(event, pk):
    workout_id = path_id(event)
    workout = validate_workout(parse_body(event))
    existing = find_by_id(pk, workout_id)
    if existing is None:
        raise ApiError(404, "Workout not found")
    item = to_item(pk, workout_id, workout)
    table = get_table()
    table.put_item(Item=item)
    if existing["SK"] != item["SK"]:  # date changed, e.g. a planned workout started today
        table.delete_item(Key={"PK": pk, "SK": existing["SK"]})
    return respond(200, public(item))


def delete_workout(event, pk):
    workout_id = path_id(event)
    existing = find_by_id(pk, workout_id)
    if existing is None:
        raise ApiError(404, "Workout not found")
    get_table().delete_item(Key={"PK": pk, "SK": existing["SK"]})
    return respond(204)


# ================================================================== crew
# Everything below is additive. A member's own items are still only reached
# through the JWT sub; other members' workouts are read server-side and
# reduced to numbers before anything leaves the Lambda.
CREW_PK = "CREW"
PALETTE = ["#B8F23A", "#2EC5FF", "#FF6B6B", "#FFB547", "#C084FC", "#FF5FA2", "#20D6A5", "#F4F4F8"]
SHAPES = ["circle", "square", "triangle", "diamond", "triangle-down", "star", "plus", "cross"]
GOAL_TYPES = ("weight", "e1rm", "perWeek", "volume")
COMP_METRICS = ("e1rmPct", "workouts", "volume", "streak")
SERIES_METRICS = ("e1rm", "volume", "top")
FEED_TTL_DAYS = 90
MEMBER_ID_RE = re.compile(r"^[a-f0-9]{12}$")


def today():
    return datetime.date.today().isoformat()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def sub_of(pk):
    return pk[len("USER#"):]


def norm(name):
    return " ".join(str(name).split()).lower()


def clean_text(value, field, max_len):
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, f"{field} is required")
    value = " ".join(value.split())
    if len(value) > max_len:
        raise ApiError(400, f"{field} must be {max_len} characters or fewer")
    return value


def positive_number(value, field, max_value=100000):
    n = valid_number(value, field)
    if n <= 0:
        raise ApiError(400, f"{field} must be more than 0")
    if n > max_value:
        raise ApiError(400, f"{field} is too large")
    return n


# ---------------------------------------------------------------- metrics
# Pure functions over workout items; shared by goals, competitions and the
# crew chart so they always agree with each other and with the solo chart.
def f(x):
    return float(x) if x is not None else 0.0


def epley(s):
    reps, weight = f(s.get("reps")), f(s.get("weight"))
    if reps <= 0:
        return 0.0
    return weight if reps == 1 else weight * (1 + reps / 30)


def completed_workouts(workouts, start=None, end=None):
    return [w for w in workouts if w.get("status") == "completed"
            and (start is None or w["date"] >= start) and (end is None or w["date"] <= end)]


def exercise_sets(workout, exercise):
    k = norm(exercise)
    return [s for e in workout.get("exercises", []) if norm(e.get("name", "")) == k for s in e.get("sets", [])]


def daily_metric(workouts, exercise, metric):
    """{date: value} for one exercise: best e1RM, total volume or top set."""
    out = {}
    for w in completed_workouts(workouts):
        sets = exercise_sets(w, exercise)
        if not sets:
            continue
        if metric == "e1rm":
            v = max((epley(s) for s in sets), default=0.0)
        elif metric == "volume":
            v = sum(f(s.get("reps")) * f(s.get("weight")) for s in sets)
        else:  # top
            v = max((f(s.get("weight")) for s in sets if f(s.get("reps")) > 0), default=0.0)
        if v <= 0:
            continue
        cur = out.get(w["date"])
        out[w["date"]] = v if cur is None else (cur + v if metric == "volume" else max(cur, v))
    return out


def best(workouts, exercise, metric, start=None, end=None):
    vals = [v for d, v in daily_metric(workouts, exercise, metric).items()
            if (start is None or d >= start) and (end is None or d <= end)]
    return max(vals, default=0.0)


def total_volume(workouts, start=None, end=None):
    return sum(f(s.get("reps")) * f(s.get("weight"))
               for w in completed_workouts(workouts, start, end)
               for e in w.get("exercises", []) for s in e.get("sets", []))


def monday(iso):
    d = datetime.date.fromisoformat(iso)
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def add_days(iso, n):
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=n)).isoformat()


def weekly_counts(workouts, start, end):
    """[(week_monday, completed sessions)] for every Mon-Sun week touching [start, end]."""
    counts = {}
    for w in completed_workouts(workouts, start, end):
        counts[monday(w["date"])] = counts.get(monday(w["date"]), 0) + 1
    weeks, wk = [], monday(start)
    while wk <= end:
        weeks.append((wk, counts.get(wk, 0)))
        wk = add_days(wk, 7)
    return weeks


def longest_streak(workouts, start, end, target):
    run = longest = 0
    for _, n in weekly_counts(workouts, start, end):
        run = run + 1 if n >= target else 0
        longest = max(longest, run)
    return longest


def goal_progress(goal, workouts, on=None):
    on = on or today()
    t = f(goal["target"])
    if goal["type"] == "weight":
        value = best(workouts, goal["exercise"], "top")
    elif goal["type"] == "e1rm":
        value = best(workouts, goal["exercise"], "e1rm")
    elif goal["type"] == "perWeek":
        value = float(len(completed_workouts(workouts, monday(on), add_days(monday(on), 6))))
    else:  # volume over a date range
        value = total_volume(workouts, goal["startDate"], goal.get("endDate") or on)
    pct = 0.0 if t <= 0 else min(100.0, round(value / t * 100, 1))
    return {"value": round(value, 1), "target": round(t, 1), "pct": pct}


def comp_score(comp, workouts, on=None):
    """None means 'no data yet' (never shown as a low score)."""
    on = on or today()
    start, end = comp["startDate"], min(comp["endDate"], on)
    if end < start:
        return None
    m = comp["metric"]
    if m == "workouts":
        return float(len(completed_workouts(workouts, start, end)))
    if m == "volume":
        return round(total_volume(workouts, start, end), 1)
    if m == "streak":
        return float(longest_streak(workouts, start, end, int(f(comp["weeklyTarget"]))))
    # e1rmPct: progress against your own starting point
    baseline = best(workouts, comp["exercise"], "e1rm", end=add_days(start, -1))
    if baseline <= 0:  # nothing before the start: first week is the baseline
        baseline = best(workouts, comp["exercise"], "e1rm", start, min(add_days(start, 6), end))
    current = best(workouts, comp["exercise"], "e1rm", start, end)
    if baseline <= 0 or current <= 0:
        return None
    return round((current / baseline - 1) * 100, 1)


# ---------------------------------------------------------------- members
def all_members():
    return query_all(KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                     ExpressionAttributeValues={":pk": CREW_PK, ":prefix": "MEMBER#"})


def get_member(sub):
    return get_table().get_item(Key={"PK": CREW_PK, "SK": f"MEMBER#{sub}"}).get("Item")


def require_member(sub):
    m = get_member(sub)
    if m is None:
        raise ApiError(409, "Set up your profile first")
    return m


def visible_members(caller_sub):
    """Members whose data may be shown to the caller: everyone sharing, plus
    the caller themself (you always see your own data)."""
    return [m for m in all_members() if m.get("sharing", True) or m["sub"] == caller_sub]


def public_member(m, caller_sub=None):
    out = {"memberId": m["memberId"], "displayName": m["displayName"], "colour": m["colour"], "shape": m["shape"]}
    if caller_sub is not None:
        out["isMe"] = m["sub"] == caller_sub
    return out


def member_workouts(sub):
    # The partition comes from our own member record, never from the request.
    return query_all(KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                     ExpressionAttributeValues={":pk": f"USER#{sub}", ":prefix": "WORKOUT#"})


def feed_add(kind, actor, subject=None, ref=None, label=None):
    ts = now_iso()
    item = {"PK": CREW_PK, "SK": f"FEED#{ts}#{uuid.uuid4().hex[:8]}", "kind": kind, "actor": actor,
            "createdAt": ts, "expiresAt": int(datetime.datetime.now().timestamp()) + FEED_TTL_DAYS * 86400}
    if subject:
        item["subject"] = subject
    if ref:
        item["ref"] = ref
    if label:
        item["label"] = label
    get_table().put_item(Item=item)


def get_me(event, pk):
    m = get_member(sub_of(pk))
    if m is None:
        raise ApiError(404, "No profile yet")
    taken = {x["colour"] for x in all_members() if x["sub"] != m["sub"]}
    return respond(200, {**public_member(m), "sharing": bool(m.get("sharing", True)),
                         "palette": [{"colour": c, "taken": c in taken} for c in PALETTE]})


def put_me(event, pk):
    sub = sub_of(pk)
    body = parse_body(event)
    members = all_members()
    me = next((m for m in members if m["sub"] == sub), None)
    others = [m for m in members if m["sub"] != sub]
    taken = {m["colour"] for m in others}
    item = dict(me) if me else {
        "PK": CREW_PK, "SK": f"MEMBER#{sub}", "sub": sub, "memberId": uuid.uuid4().hex[:12],
        "sharing": True, "joinedAt": now_iso(),
        # sign-up order: first colour and shape nobody has yet
        "colour": next((c for c in PALETTE if c not in taken), PALETTE[len(others) % len(PALETTE)]),
        "shape": next((s for s in SHAPES if s not in {m["shape"] for m in others}), SHAPES[len(others) % len(SHAPES)]),
    }
    if "displayName" in body or me is None:
        item["displayName"] = clean_text(body.get("displayName"), "Display name", 30)
    if "colour" in body:
        colour = body["colour"]
        if colour not in PALETTE:
            raise ApiError(400, "Pick one of the crew colours")
        if colour in taken and len(taken) < len(PALETTE):
            raise ApiError(409, "Someone already has that colour")
        item["colour"] = colour
    if "sharing" in body:
        if not isinstance(body["sharing"], bool):
            raise ApiError(400, "sharing must be true or false")
        item["sharing"] = body["sharing"]
    get_table().put_item(Item=item)
    return respond(200 if me else 201, {**public_member(item), "sharing": item["sharing"]})


# ---------------------------------------------------------------- goals
def validate_goal(body):
    t = body.get("type")
    if t not in GOAL_TYPES:
        raise ApiError(400, "type must be weight, e1rm, perWeek or volume")
    goal = {"type": t}
    if t in ("weight", "e1rm"):
        goal["exercise"] = clean_text(body.get("exercise"), "Exercise", MAX_NAME_LEN)
        goal["target"] = positive_number(body.get("target"), "target")
    elif t == "perWeek":
        goal["target"] = positive_number(body.get("target"), "target", 14)
    else:
        goal["target"] = positive_number(body.get("target"), "target", 10_000_000)
        goal["startDate"] = valid_date(body.get("startDate"), "startDate")
        goal["endDate"] = valid_date(body.get("endDate"), "endDate")
        if goal["endDate"] < goal["startDate"]:
            raise ApiError(400, "endDate must be on or after startDate")
    if body.get("deadline") is not None:
        goal["deadline"] = valid_date(body.get("deadline"), "deadline")
    return goal


def goal_label(g):
    t = f(g["target"])
    n = int(t) if t == int(t) else t
    return {"weight": f"{g.get('exercise')} {n} kg", "e1rm": f"{g.get('exercise')} est. 1RM {n} kg",
            "perWeek": f"{n}x a week", "volume": f"{n:,} kg total volume"}[g["type"]]


def own_goals(sub):
    return query_all(KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                     ExpressionAttributeValues={":pk": f"USER#{sub}", ":prefix": "GOAL#"})


def refresh_goal(goal, workouts, actor_member_id):
    """Adds live progress; marks a goal complete (once) and posts to the feed."""
    prog = goal_progress(goal, workouts)
    if goal.get("status") == "active" and prog["value"] >= prog["target"]:
        if goal["type"] == "perWeek":
            wk = monday(today())
            if goal.get("lastHitWeek") != wk:  # habit goal: celebrate once a week, stays active
                goal["lastHitWeek"] = wk
                get_table().put_item(Item=goal)
                if actor_member_id:
                    feed_add("goalDone", actor_member_id, ref=goal["id"], label=goal_label(goal) + " this week")
        else:
            goal["status"], goal["completedAt"] = "completed", now_iso()
            get_table().put_item(Item=goal)
            if actor_member_id:
                feed_add("goalDone", actor_member_id, ref=goal["id"], label=goal_label(goal))
    return prog


def goal_public(goal, prog):
    keys = ("id", "type", "exercise", "target", "startDate", "endDate", "deadline", "status", "completedAt", "createdAt")
    return {**{k: goal[k] for k in keys if k in goal}, "label": goal_label(goal), "progress": prog}


def list_goals(event, pk):
    sub = sub_of(pk)
    me = get_member(sub)
    workouts = member_workouts(sub)
    goals = own_goals(sub)
    out = [goal_public(g, refresh_goal(g, workouts, me and me["memberId"])) for g in goals]
    return respond(200, {"items": out})


def create_goal(event, pk):
    goal = validate_goal(parse_body(event))
    gid = uuid.uuid4().hex[:12]
    item = {"PK": pk, "SK": f"GOAL#{gid}", "id": gid, "status": "active", "createdAt": now_iso(), **goal}
    if goal["type"] != "volume":
        item["startDate"] = today()
    get_table().put_item(Item=item)
    me = get_member(sub_of(pk))
    prog = refresh_goal(item, member_workouts(sub_of(pk)), me and me["memberId"])
    return respond(201, goal_public(item, prog))


def update_goal(event, pk):
    gid = path_id(event)
    existing = get_table().get_item(Key={"PK": pk, "SK": f"GOAL#{gid}"}).get("Item")
    if existing is None:
        raise ApiError(404, "Goal not found")
    goal = validate_goal(parse_body(event))
    item = {**{k: existing[k] for k in ("PK", "SK", "id", "createdAt", "startDate") if k in existing},
            "status": "active", **goal}
    get_table().put_item(Item=item)
    me = get_member(sub_of(pk))
    return respond(200, goal_public(item, refresh_goal(item, member_workouts(sub_of(pk)), me and me["memberId"])))


def delete_goal(event, pk):
    gid = path_id(event)
    if get_table().get_item(Key={"PK": pk, "SK": f"GOAL#{gid}"}).get("Item") is None:
        raise ApiError(404, "Goal not found")
    get_table().delete_item(Key={"PK": pk, "SK": f"GOAL#{gid}"})
    return respond(204)


# ---------------------------------------------------------------- crew views
def crew_overview(event, pk):
    sub = sub_of(pk)
    me = require_member(sub)
    members = visible_members(sub)
    by_member = {m["memberId"]: m for m in members}
    goals, exercises = [], set()
    for m in members:
        workouts = member_workouts(m["sub"])
        exercises.update(e.get("name", "").strip() for w in completed_workouts(workouts) for e in w.get("exercises", []))
        for g in own_goals(m["sub"]):
            prog = refresh_goal(g, workouts, m["memberId"])
            if g.get("status") == "active" or g.get("completedAt", "") >= add_days(today(), -14):
                goals.append({"memberId": m["memberId"], "goalId": g["id"], "type": g["type"], "exercise": g.get("exercise"),
                              "label": goal_label(g), "status": g["status"], "deadline": g.get("deadline"),
                              "progressPct": prog["pct"], "value": prog["value"], "target": prog["target"]})
    feed = []
    for it in get_table().query(KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                                ExpressionAttributeValues={":pk": CREW_PK, ":prefix": "FEED#"},
                                ScanIndexForward=False, Limit=60).get("Items", []):
        # hide anything involving someone who isn't sharing
        if it["actor"] in by_member and (not it.get("subject") or it["subject"] in by_member):
            feed.append({k: it[k] for k in ("kind", "actor", "subject", "ref", "label", "createdAt") if k in it})
    return respond(200, {"me": public_member(me, sub), "sharing": bool(me.get("sharing", True)),
                         "members": [public_member(m, sub) for m in members],
                         "goals": goals, "feed": feed[:30],
                         "exerciseNames": sorted({e for e in exercises if e}, key=str.lower)})


def crew_series(event, pk):
    sub = sub_of(pk)
    require_member(sub)
    qs = event.get("queryStringParameters") or {}
    exercise = clean_text(qs.get("exercise"), "exercise", MAX_NAME_LEN)
    metric = qs.get("metric", "e1rm")
    if metric not in SERIES_METRICS:
        raise ApiError(400, "metric must be e1rm, volume or top")
    series = []
    for m in visible_members(sub):
        points = daily_metric(member_workouts(m["sub"]), exercise, metric)
        if points:
            series.append({**public_member(m, sub),
                           "points": [{"date": d, "value": round(v, 1)} for d, v in sorted(points.items())]})
    return respond(200, {"exercise": exercise, "metric": metric, "series": series})


def post_cheer(event, pk):
    sub = sub_of(pk)
    me = require_member(sub)
    body = parse_body(event)
    target_id = body.get("memberId")
    ref = body.get("ref")
    if not isinstance(target_id, str) or not MEMBER_ID_RE.match(target_id):
        raise ApiError(400, "memberId is invalid")
    if not isinstance(ref, str) or not ID_RE.match(ref):
        raise ApiError(400, "ref is invalid")
    target = next((m for m in visible_members(sub) if m["memberId"] == target_id), None)
    if target is None:
        raise ApiError(404, "Member not found")
    label = clean_text(body.get("label") or "their progress", "label", 80)
    # one cheer per person, per thing, per day
    marker = {"PK": CREW_PK, "SK": f"CHEER#{today()}#{me['memberId']}#{target_id}#{ref}",
              "expiresAt": int(datetime.datetime.now().timestamp()) + 2 * 86400}
    try:
        get_table().put_item(Item=marker, ConditionExpression="attribute_not_exists(PK)")
    except Exception as e:  # ConditionalCheckFailed
        if "ConditionalCheckFailed" in str(e) or type(e).__name__ == "ConditionalCheckFailedException":
            return respond(200, {"ok": True, "already": True})
        raise
    feed_add("cheer", me["memberId"], subject=target_id, ref=ref, label=label)
    return respond(201, {"ok": True})


# ---------------------------------------------------------------- competitions
COMP_TITLES = {"e1rmPct": "Biggest improvers", "workouts": "Most sessions",
               "volume": "Most volume moved", "streak": "Most consistent"}


def validate_comp(body):
    comp = {"name": clean_text(body.get("name"), "Name", 40)}
    metric = body.get("metric", "e1rmPct")
    if metric not in COMP_METRICS:
        raise ApiError(400, "metric must be e1rmPct, workouts, volume or streak")
    comp["metric"] = metric
    comp["startDate"] = valid_date(body.get("startDate"), "startDate")
    comp["endDate"] = valid_date(body.get("endDate"), "endDate")
    if comp["endDate"] < comp["startDate"]:
        raise ApiError(400, "endDate must be on or after startDate")
    if comp["endDate"] < today():
        raise ApiError(400, "endDate can't be in the past")
    if metric == "e1rmPct":
        comp["exercise"] = clean_text(body.get("exercise"), "Exercise", MAX_NAME_LEN)
    if metric == "streak":
        comp["weeklyTarget"] = positive_number(body.get("weeklyTarget"), "weeklyTarget", 7)
    return comp


def all_comps():
    return query_all(KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
                     ExpressionAttributeValues={":pk": CREW_PK, ":prefix": "COMP#"})


def rank(scored):
    """[(member, score)] -> standings; ties share a rank. Anyone without a
    positive score yet is listed unranked ("warming up"), never as last."""
    with_score = sorted([x for x in scored if x[1] is not None and x[1] > 0], key=lambda x: -x[1])
    out, prev, r = [], None, 0
    for i, (m, s) in enumerate(with_score, 1):
        if s != prev:
            r, prev = i, s
        out.append((r, m, s))
    return out + [(None, m, None) for m, s in scored if s is None or s <= 0]


def comp_view(comp, sub, members_by_sub):
    finished = comp["endDate"] < today()
    if finished and "result" not in comp:
        scores = {p: comp_score(comp, member_workouts(p)) for p in comp.get("participants", [])}
        comp["result"] = [{"sub": p, "score": None if s is None else Decimal(str(s))} for p, s in scores.items()]
        try:
            get_table().put_item(Item=comp, ConditionExpression="attribute_not_exists(#r)",
                                 ExpressionAttributeNames={"#r": "result"})
            creator = members_by_sub.get(comp.get("createdBySub"))
            feed_add("compFinished", creator["memberId"] if creator else "", ref=comp["id"], label=comp["name"])
        except Exception as e:
            if "ConditionalCheckFailed" not in str(e) and type(e).__name__ != "ConditionalCheckFailedException":
                raise
    if "result" in comp:
        scored = [(members_by_sub[r["sub"]], None if r["score"] is None else f(r["score"]))
                  for r in comp["result"] if r["sub"] in members_by_sub]
    else:
        scored = [(members_by_sub[p], comp_score(comp, member_workouts(p)))
                  for p in comp.get("participants", []) if p in members_by_sub]
    status = "finished" if finished else ("upcoming" if comp["startDate"] > today() else "live")
    return {**{k: comp[k] for k in ("id", "name", "metric", "exercise", "weeklyTarget", "startDate", "endDate") if k in comp},
            "title": COMP_TITLES[comp["metric"]], "status": status,
            "joined": sub in comp.get("participants", []),
            "standings": [{"rank": r, **public_member(m, sub), "score": s} for r, m, s in rank(scored)]}


def list_comps(event, pk):
    sub = sub_of(pk)
    require_member(sub)
    members_by_sub = {m["sub"]: m for m in visible_members(sub)}
    comps = sorted(all_comps(), key=lambda c: (c["endDate"] < today(), c["endDate"]))
    return respond(200, {"items": [comp_view(c, sub, members_by_sub) for c in comps]})


def create_comp(event, pk):
    sub = sub_of(pk)
    me = require_member(sub)
    comp = validate_comp(parse_body(event))
    cid = uuid.uuid4().hex[:12]
    item = {"PK": CREW_PK, "SK": f"COMP#{cid}", "id": cid, "createdBySub": sub, "createdAt": now_iso(),
            "participants": [sub] if me.get("sharing", True) else [], **comp}
    get_table().put_item(Item=item)
    feed_add("compCreated", me["memberId"], ref=cid, label=comp["name"])
    return respond(201, comp_view(item, sub, {m["sub"]: m for m in visible_members(sub)}))


def join_comp(event, pk):
    sub = sub_of(pk)
    me = require_member(sub)
    if not me.get("sharing", True):
        raise ApiError(403, "Turn on sharing with the crew to join competitions")
    cid = path_id(event)
    comp = get_table().get_item(Key={"PK": CREW_PK, "SK": f"COMP#{cid}"}).get("Item")
    if comp is None:
        raise ApiError(404, "Competition not found")
    if comp["endDate"] < today():
        raise ApiError(409, "This competition has finished")
    if sub not in comp.get("participants", []):
        comp["participants"] = list(comp.get("participants", [])) + [sub]
        get_table().put_item(Item=comp)
        feed_add("compJoined", me["memberId"], ref=cid, label=comp["name"])
    return respond(200, comp_view(comp, sub, {m["sub"]: m for m in visible_members(sub)}))


ROUTES = {
    "GET /workouts": list_workouts,
    "POST /workouts": create_workout,
    "PUT /workouts/{id}": update_workout,
    "DELETE /workouts/{id}": delete_workout,
    "GET /me": get_me,
    "PUT /me": put_me,
    "GET /goals": list_goals,
    "POST /goals": create_goal,
    "PUT /goals/{id}": update_goal,
    "DELETE /goals/{id}": delete_goal,
    "GET /crew": crew_overview,
    "GET /crew/series": crew_series,
    "POST /crew/cheers": post_cheer,
    "GET /competitions": list_comps,
    "POST /competitions": create_comp,
    "POST /competitions/{id}/join": join_comp,
}


def lambda_handler(event, context):
    try:
        route = ROUTES.get(event.get("routeKey"))
        if route is None:
            raise ApiError(404, "Not found")
        return route(event, user_pk(event))
    except ApiError as e:
        return respond(e.status, {"error": e.message})
    except Exception:
        logger.exception("Unhandled error")
        return respond(500, {"error": "Internal error"})
