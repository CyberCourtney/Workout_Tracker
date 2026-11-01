"""Workout tracker API (API Gateway HTTP API, payload v2, JWT authorizer).

Routes:
  GET    /workouts?from=YYYY-MM-DD&to=YYYY-MM-DD
  POST   /workouts
  PUT    /workouts/{id}
  DELETE /workouts/{id}

The user is always taken from the verified JWT `sub` claim, never from the
request. Items: PK = USER#<sub>, SK = WORKOUT#<YYYY-MM-DD>#<id>.
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


ROUTES = {
    "GET /workouts": list_workouts,
    "POST /workouts": create_workout,
    "PUT /workouts/{id}": update_workout,
    "DELETE /workouts/{id}": delete_workout,
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
