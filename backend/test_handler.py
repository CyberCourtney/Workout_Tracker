"""Unit tests for handler.py. Run from the backend/ folder: python -m unittest"""

import copy
import json
import re
import unittest
from decimal import Decimal
from unittest import mock

import handler


class FakeTable:
    """In-memory stand-in for a DynamoDB Table, supporting the key condition
    shapes and condition expressions handler.py uses."""

    def __init__(self):
        self.items = {}
        self.calls = []

    def get_item(self, Key):
        self.calls.append(("get_item", Key["PK"]))
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeNames=None):
        self.calls.append(("put_item", Item["PK"]))
        key = (Item["PK"], Item["SK"])
        existing = self.items.get(key)
        if ConditionExpression == "attribute_not_exists(PK)" and existing is not None:
            raise RuntimeError("ConditionalCheckFailed")
        if ConditionExpression == "attribute_not_exists(#r)" and existing is not None \
                and ExpressionAttributeNames["#r"] in existing:
            raise RuntimeError("ConditionalCheckFailed")
        self.items[key] = copy.deepcopy(Item)

    def delete_item(self, Key):
        self.calls.append(("delete_item", Key["PK"]))
        self.items.pop((Key["PK"], Key["SK"]), None)

    def query(self, KeyConditionExpression, ExpressionAttributeValues, ExclusiveStartKey=None,
              ScanIndexForward=True, Limit=None):
        v = ExpressionAttributeValues
        pk = v[":pk"]
        self.calls.append(("query", pk))
        if re.fullmatch(r"PK = :pk AND begins_with\(SK, :prefix\)", KeyConditionExpression):
            match = lambda sk: sk.startswith(v[":prefix"])
        elif re.fullmatch(r"PK = :pk AND SK BETWEEN :lo AND :hi", KeyConditionExpression):
            match = lambda sk: v[":lo"] <= sk <= v[":hi"]
        else:
            raise AssertionError(f"unexpected expression {KeyConditionExpression}")
        items = [copy.deepcopy(i) for (p, sk), i in sorted(self.items.items()) if p == pk and match(sk)]
        if not ScanIndexForward:
            items.reverse()
        return {"Items": items[:Limit] if Limit else items}


def event(route, sub="user-a", body=None, qs=None, path=None, b64=False):
    e = {
        "routeKey": route,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub}}}},
        "queryStringParameters": qs,
        "pathParameters": path,
    }
    if body is not None:
        e["body"] = body if isinstance(body, str) else json.dumps(body)
    if b64:
        import base64

        e["body"] = base64.b64encode(e["body"].encode()).decode()
        e["isBase64Encoded"] = True
    return e


def workout(date="2026-10-30", status="completed", **over):
    w = {
        "date": date,
        "status": status,
        "exercises": [{"name": "Bench press", "sets": [{"reps": 5, "weight": 60}, {"reps": 5, "weight": 62.5}]}],
    }
    w.update(over)
    return w


def call(e):
    res = handler.lambda_handler(e, None)
    body = json.loads(res["body"]) if res["body"] else None
    return res["statusCode"], body


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        patcher = mock.patch.object(handler, "get_table", return_value=self.table)
        patcher.start()
        self.addCleanup(patcher.stop)

    def create(self, sub="user-a", **kw):
        status, body = call(event("POST /workouts", sub=sub, body=workout(**kw)))
        self.assertEqual(status, 201, body)
        return body

    # ---------------------------------------------------------------- create
    def test_create_stores_item_under_jwt_user(self):
        w = self.create()
        self.assertEqual(w["date"], "2026-10-30")
        self.assertEqual(w["status"], "completed")
        self.assertEqual(w["exercises"][0]["sets"][1], {"reps": 5, "weight": 62.5})
        self.assertIn("updatedAt", w)
        ((pk, sk),) = self.table.items.keys()
        self.assertEqual(pk, "USER#user-a")
        self.assertEqual(sk, f"WORKOUT#2026-10-30#{w['id']}")

    def test_create_ignores_user_and_keys_in_body(self):
        body = workout()
        body.update({"PK": "USER#user-b", "SK": "WORKOUT#x", "userId": "user-b", "id": "chosen"})
        status, w = call(event("POST /workouts", body=body))
        self.assertEqual(status, 201)
        self.assertNotEqual(w["id"], "chosen")
        ((pk, _),) = self.table.items.keys()
        self.assertEqual(pk, "USER#user-a")

    def test_create_planned(self):
        w = self.create(date="2030-01-01", status="planned")
        self.assertEqual(w["status"], "planned")

    def test_base64_body(self):
        status, _ = call(event("POST /workouts", body=workout(), b64=True))
        self.assertEqual(status, 201)

    # ---------------------------------------------------------------- read
    def test_read_by_date_range(self):
        a = self.create(date="2026-10-01")
        b = self.create(date="2026-10-15")
        self.create(date="2026-11-01")
        status, body = call(event("GET /workouts", qs={"from": "2026-10-01", "to": "2026-10-31"}))
        self.assertEqual(status, 200)
        self.assertEqual({i["id"] for i in body["items"]}, {a["id"], b["id"]})
        self.assertTrue(all("PK" not in i and "SK" not in i for i in body["items"]))

    def test_read_range_is_inclusive_of_single_day(self):
        a = self.create(date="2026-10-15")
        _, body = call(event("GET /workouts", qs={"from": "2026-10-15", "to": "2026-10-15"}))
        self.assertEqual([i["id"] for i in body["items"]], [a["id"]])

    def test_read_requires_valid_range(self):
        for qs in (None, {"from": "2026-10-01"}, {"from": "2026-13-01", "to": "2026-12-01"},
                   {"from": "2026-10-31", "to": "2026-10-01"}, {"from": "1/10/2026", "to": "2026-10-01"}):
            status, body = call(event("GET /workouts", qs=qs))
            self.assertEqual(status, 400, qs)
            self.assertIn("error", body)

    # ---------------------------------------------------------------- update
    def test_update(self):
        w = self.create()
        changed = workout(exercises=[{"name": "Squat", "sets": [{"reps": 3, "weight": 100}]}])
        status, body = call(event("PUT /workouts/{id}", body=changed, path={"id": w["id"]}))
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], w["id"])
        self.assertEqual(body["exercises"][0]["name"], "Squat")
        self.assertEqual(len(self.table.items), 1)

    def test_update_moving_date_replaces_item(self):
        w = self.create(date="2030-01-01", status="planned")
        status, body = call(event("PUT /workouts/{id}", body=workout(date="2026-11-01"), path={"id": w["id"]}))
        self.assertEqual(status, 200)
        self.assertEqual(list(self.table.items.keys()), [("USER#user-a", f"WORKOUT#2026-11-01#{w['id']}")])
        self.assertEqual(body["status"], "completed")

    def test_update_missing_is_404(self):
        status, _ = call(event("PUT /workouts/{id}", body=workout(), path={"id": "nope"}))
        self.assertEqual(status, 404)

    # ---------------------------------------------------------------- delete
    def test_delete(self):
        w = self.create()
        status, _ = call(event("DELETE /workouts/{id}", path={"id": w["id"]}))
        self.assertEqual(status, 204)
        self.assertEqual(self.table.items, {})
        status, _ = call(event("DELETE /workouts/{id}", path={"id": w["id"]}))
        self.assertEqual(status, 404)

    # ---------------------------------------------------------------- isolation
    def test_user_cannot_read_update_or_delete_another_users_items(self):
        w = self.create(sub="user-a")
        _, body = call(event("GET /workouts", sub="user-b", qs={"from": "2000-01-01", "to": "2100-01-01"}))
        self.assertEqual(body["items"], [])
        status, _ = call(event("PUT /workouts/{id}", sub="user-b", body=workout(), path={"id": w["id"]}))
        self.assertEqual(status, 404)
        status, _ = call(event("DELETE /workouts/{id}", sub="user-b", path={"id": w["id"]}))
        self.assertEqual(status, 404)
        self.assertEqual(len(self.table.items), 1)
        # every DynamoDB call made for user-b stayed inside user-b's partition
        self.assertTrue(all(pk == "USER#user-b" for op, pk in self.table.calls[1:]))

    def test_missing_jwt_is_401(self):
        e = event("GET /workouts", qs={"from": "2026-01-01", "to": "2026-01-02"})
        e["requestContext"] = {}
        status, _ = call(e)
        self.assertEqual(status, 401)

    # ---------------------------------------------------------------- validation
    def assert_rejected(self, body, status=400):
        got, res = call(event("POST /workouts", body=body))
        self.assertEqual(got, status, body)
        self.assertIn("error", res)
        self.assertEqual(self.table.items, {})

    def test_rejects_bad_dates(self):
        for d in ("2026-1-5", "2026-02-30", "tomorrow", None, 20261101):
            self.assert_rejected(workout(date=d))

    def test_rejects_bad_status(self):
        for s in ("done", None, "PLANNED"):
            self.assert_rejected(workout(status=s))

    def test_rejects_negative_or_non_numeric_sets(self):
        for s in ({"reps": -1, "weight": 10}, {"reps": 5, "weight": -2.5}, {"reps": "5", "weight": 10},
                  {"reps": 5, "weight": "heavy"}, {"reps": True, "weight": 10}, {"reps": 5}, {"weight": 10}):
            self.assert_rejected(workout(exercises=[{"name": "Row", "sets": [s]}]))

    def test_rejects_nan(self):
        self.assert_rejected('{"date":"2026-10-30","status":"completed","exercises":[{"name":"Row","sets":[{"reps":NaN,"weight":1}]}]}')

    def test_rejects_too_many_exercises_or_sets(self):
        ex = {"name": "Curl", "sets": [{"reps": 1, "weight": 1}]}
        self.assert_rejected(workout(exercises=[ex] * 31))
        self.assert_rejected(workout(exercises=[{"name": "Curl", "sets": [{"reps": 1, "weight": 1}] * 21}]))
        # the limits themselves are allowed
        status, _ = call(event("POST /workouts", body=workout(exercises=[{"name": "Curl", "sets": [{"reps": 1, "weight": 1}] * 20}] * 30)))
        self.assertEqual(status, 201)

    def test_rejects_missing_names_and_empty_workouts(self):
        self.assert_rejected(workout(exercises=[]))
        self.assert_rejected(workout(exercises=[{"name": "  ", "sets": []}]))

    def test_rejects_oversized_and_invalid_bodies(self):
        self.assert_rejected("x" * (100 * 1024 + 1), status=413)
        self.assert_rejected("{not json")
        self.assert_rejected("[1,2]")

    def test_rejects_bad_path_id(self):
        status, _ = call(event("DELETE /workouts/{id}", path={"id": "../etc"}))
        self.assertEqual(status, 400)

    def test_unexpected_error_does_not_leak(self):
        with mock.patch.object(self.table, "put_item", side_effect=RuntimeError("secret stack detail")):
            with self.assertLogs(handler.logger, level="ERROR"):
                status, body = call(event("POST /workouts", body=workout()))
        self.assertEqual(status, 500)
        self.assertEqual(body, {"error": "Internal error"})

    def test_unknown_route(self):
        status, _ = call(event("PATCH /workouts"))
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
