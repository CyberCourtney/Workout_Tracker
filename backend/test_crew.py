"""Tests for the crew layer: profiles, goals, crew views, competitions and
the invite-code sign-up trigger. Run from backend/: python -m unittest"""

import datetime
import json
import os
import unittest
from unittest import mock

import handler
import presignup
from test_handler import FakeTable, event

TODAY = datetime.date.today()


def d(offset):
    return (TODAY + datetime.timedelta(days=offset)).isoformat()


def call(e):
    res = handler.lambda_handler(e, None)
    return res["statusCode"], (json.loads(res["body"]) if res["body"] else None)


def keys_in(obj):
    """Every dict key anywhere in a JSON value."""
    if isinstance(obj, dict):
        return set(obj) | set().union(*(keys_in(v) for v in obj.values()))
    if isinstance(obj, list):
        return set().union(*(keys_in(v) for v in obj)) if obj else set()
    return set()


RAW_KEYS = {"sets", "reps", "notes", "exercises", "sub", "PK", "SK", "participants", "result"}


class CrewBase(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        patcher = mock.patch.object(handler, "get_table", return_value=self.table)
        patcher.start()
        self.addCleanup(patcher.stop)

    def ok(self, route, sub, body=None, qs=None, path=None, expect=(200, 201, 204)):
        status, res = call(event(route, sub=sub, body=body, qs=qs, path=path))
        self.assertIn(status, expect if isinstance(expect, tuple) else (expect,), res)
        return res

    def profile(self, sub, name, **extra):
        return self.ok("PUT /me", sub, {"displayName": name, **extra})

    def log(self, sub, date, exercise="Bench press", sets=((5, 60),), status="completed"):
        return self.ok("POST /workouts", sub, {"date": date, "status": status, "exercises": [
            {"name": exercise, "sets": [{"reps": r, "weight": w} for r, w in sets]}]})


# ------------------------------------------------------------------ profiles
class ProfileTests(CrewBase):
    def test_first_profile_gets_first_colour_and_shape(self):
        me = self.profile("a", "Courtney")
        self.assertEqual((me["colour"], me["shape"], me["sharing"]), ("#B8F23A", "circle", True))
        self.assertRegex(me["memberId"], r"^[a-f0-9]{12}$")

    def test_colours_assigned_in_signup_order_skipping_taken(self):
        self.profile("a", "A")
        self.profile("b", "B", colour="#FF6B6B")  # B picks coral up front
        c = self.profile("c", "C")
        self.assertEqual(c["colour"], "#2EC5FF")  # lime taken by A, so sky
        self.assertEqual(c["shape"], "triangle")

    def test_cannot_take_someone_elses_colour(self):
        self.profile("a", "A")
        self.profile("b", "B")
        status, _ = call(event("PUT /me", sub="b", body={"colour": "#B8F23A"}))
        self.assertEqual(status, 409)
        self.assertEqual(self.profile("b", "B", colour="#C084FC")["colour"], "#C084FC")

    def test_me_404_before_setup_and_validates_name(self):
        status, _ = call(event("GET /me", sub="a"))
        self.assertEqual(status, 404)
        status, _ = call(event("PUT /me", sub="a", body={"displayName": "  "}))
        self.assertEqual(status, 400)

    def test_profile_key_comes_from_jwt(self):
        self.ok("PUT /me", "a", {"displayName": "A", "sub": "b", "PK": "CREW", "SK": "MEMBER#b"})
        self.assertIn(("CREW", "MEMBER#a"), self.table.items)
        self.assertNotIn(("CREW", "MEMBER#b"), self.table.items)


# ------------------------------------------------------------------ (a) isolation
class IsolationTests(CrewBase):
    def setUp(self):
        super().setUp()
        self.profile("a", "Alex")
        self.profile("b", "Bo")
        self.b_workout = self.log("b", d(-3), "Secret lift", ((7, 77.5),))
        self.ok("POST /goals", "b", {"type": "weight", "exercise": "Secret lift", "target": 100})
        self.ok("POST /competitions", "b", {"name": "Spring", "startDate": d(-7), "endDate": d(7),
                                            "metric": "e1rmPct", "exercise": "Secret lift"})

    def test_a_cannot_read_bs_workouts_through_any_route(self):
        comp_id = self.ok("GET /competitions", "a")["items"][0]["id"]
        responses = [
            self.ok("GET /workouts", "a", qs={"from": "2000-01-01", "to": "2100-01-01"}),
            self.ok("GET /goals", "a"),
            self.ok("GET /me", "a"),
            self.ok("GET /crew", "a"),
            self.ok("GET /crew/series", "a", qs={"exercise": "Secret lift", "metric": "e1rm"}),
            self.ok("GET /competitions", "a"),
            self.ok("POST /competitions/{id}/join", "a", path={"id": comp_id}),
        ]
        self.assertEqual(responses[0]["items"], [])
        blob = json.dumps(responses)
        self.assertNotIn(self.b_workout["id"], blob)
        for r in responses[1:]:
            self.assertFalse(keys_in(r) & {"sets", "reps", "exercises"}, r)
        # writes and deletes by id are scoped to the caller's partition too
        wid = {"id": self.b_workout["id"]}
        status, _ = call(event("PUT /workouts/{id}", sub="a", path=wid, body={
            "date": d(0), "status": "completed", "exercises": [{"name": "x", "sets": []}]}))
        self.assertEqual(status, 404)
        status, _ = call(event("DELETE /workouts/{id}", sub="a", path=wid))
        self.assertEqual(status, 404)
        b_goal = self.ok("GET /goals", "b")["items"][0]["id"]
        status, _ = call(event("DELETE /goals/{id}", sub="a", path={"id": b_goal}))
        self.assertEqual(status, 404)
        self.assertEqual(len(self.ok("GET /workouts", "b", qs={"from": "2000-01-01", "to": "2100-01-01"})["items"]), 1)

    def test_crew_reads_never_change_bs_workouts(self):
        before = {k: v for k, v in self.table.items.items() if k[0] == "USER#b" and k[1].startswith("WORKOUT#")}
        for route, kw in [("GET /crew", {}), ("GET /competitions", {}), ("GET /goals", {}),
                          ("GET /crew/series", {"qs": {"exercise": "Secret lift"}})]:
            self.ok(route, "a", **kw)
        after = {k: v for k, v in self.table.items.items() if k[0] == "USER#b" and k[1].startswith("WORKOUT#")}
        self.assertEqual(before, after)


# ------------------------------------------------------------------ (b) + (c) crew privacy
class CrewPrivacyTests(CrewBase):
    def setUp(self):
        super().setUp()
        self.a = self.profile("a", "Alex")
        self.b = self.profile("b", "Bo")
        self.c = self.profile("c", "Cam")
        for sub in ("a", "b", "c"):
            self.log(sub, d(-10), sets=((5, 50),))
            self.log(sub, d(-2), sets=((5, 60),))
            self.ok("POST /goals", sub, {"type": "perWeek", "target": 4})
        self.comp = self.ok("POST /competitions", "a", {"name": "Autumn", "startDate": d(-7), "endDate": d(7),
                                                       "metric": "workouts"})
        for sub in ("b", "c"):
            self.ok("POST /competitions/{id}/join", sub, path={"id": self.comp["id"]})
        self.ok("PUT /me", "c", {"sharing": False})  # Cam stops sharing after joining

    def ids(self, items):
        return {x["memberId"] for x in items}

    def test_crew_excludes_non_sharing_members_everywhere(self):
        crew = self.ok("GET /crew", "a")
        self.assertEqual(self.ids(crew["members"]), {self.a["memberId"], self.b["memberId"]})
        self.assertNotIn(self.c["memberId"], {g["memberId"] for g in crew["goals"]})
        self.assertNotIn(self.c["memberId"], json.dumps(crew["feed"]))
        series = self.ok("GET /crew/series", "a", qs={"exercise": "bench press", "metric": "e1rm"})
        self.assertEqual(self.ids(series["series"]), {self.a["memberId"], self.b["memberId"]})
        standings = self.ok("GET /competitions", "a")["items"][0]["standings"]
        self.assertEqual(self.ids(standings), {self.a["memberId"], self.b["memberId"]})

    def test_non_sharing_member_excluded_from_locked_results(self):
        stored = self.table.items[("CREW", f"COMP#{self.comp['id']}")]
        stored["endDate"] = d(-1)  # competition has now ended
        standings = self.ok("GET /competitions", "a")["items"][0]["standings"]
        self.assertEqual(self.ids(standings), {self.a["memberId"], self.b["memberId"]})
        self.assertIn("result", self.table.items[("CREW", f"COMP#{self.comp['id']}")])

    def test_non_sharing_member_cannot_be_cheered_or_join(self):
        status, _ = call(event("POST /crew/cheers", sub="a", body={"memberId": self.c["memberId"], "ref": "abc"}))
        self.assertEqual(status, 404)
        other = self.ok("POST /competitions", "a", {"name": "Next", "startDate": d(0), "endDate": d(10), "metric": "volume"})
        status, _ = call(event("POST /competitions/{id}/join", sub="c", path={"id": other["id"]}))
        self.assertEqual(status, 403)

    def test_non_sharing_member_still_sees_own_data(self):
        crew = self.ok("GET /crew", "c")
        self.assertIn(self.c["memberId"], self.ids(crew["members"]))
        self.assertFalse(crew["sharing"])

    def test_crew_endpoints_never_return_raw_workout_data(self):
        responses = [
            self.ok("GET /crew", "a"),
            self.ok("GET /crew/series", "a", qs={"exercise": "Bench press", "metric": "e1rm"}),
            self.ok("GET /crew/series", "a", qs={"exercise": "Bench press", "metric": "volume"}),
            self.ok("GET /crew/series", "a", qs={"exercise": "Bench press", "metric": "top"}),
            self.ok("GET /competitions", "a"),
            self.ok("POST /crew/cheers", "a", {"memberId": self.b["memberId"], "ref": "goal1", "label": "4x a week"}),
        ]
        for r in responses:
            self.assertFalse(keys_in(r) & RAW_KEYS, f"raw keys leaked: {keys_in(r) & RAW_KEYS}")
        series = responses[1]["series"]
        self.assertEqual(set(series[0]["points"][0]), {"date", "value"})

    def test_cheer_appears_in_feed_once_per_day(self):
        body = {"memberId": self.b["memberId"], "ref": "goal1", "label": "4x a week"}
        self.ok("POST /crew/cheers", "a", body, expect=201)
        again = self.ok("POST /crew/cheers", "a", body, expect=200)
        self.assertTrue(again["already"])
        cheers = [f for f in self.ok("GET /crew", "b")["feed"] if f["kind"] == "cheer"]
        self.assertEqual(len(cheers), 1)
        self.assertEqual((cheers[0]["actor"], cheers[0]["subject"]), (self.a["memberId"], self.b["memberId"]))


# ------------------------------------------------------------------ (d) invite code
class PreSignUpTests(unittest.TestCase):
    def ev(self, code=None, where="validationData", source="PreSignUp_SignUp"):
        req = {"userAttributes": {"email": "f@example.com"}}
        if code is not None:
            req[where] = {"inviteCode": code}
        return {"triggerSource": source, "request": req, "response": {}}

    def test_correct_code_allowed(self):
        with mock.patch.dict(os.environ, {"INVITE_CODE": "correct-horse-42"}):
            self.assertEqual(presignup.lambda_handler(self.ev("correct-horse-42"), None)["triggerSource"], "PreSignUp_SignUp")
            presignup.lambda_handler(self.ev(" correct-horse-42 ", "clientMetadata"), None)

    def test_wrong_or_missing_code_rejected(self):
        with mock.patch.dict(os.environ, {"INVITE_CODE": "correct-horse-42"}):
            for e in (self.ev("wrong"), self.ev(""), self.ev(None), self.ev("correct-horse-4"),
                      self.ev("CORRECT-HORSE-42")):
                with self.assertRaises(Exception):
                    presignup.lambda_handler(e, None)

    def test_unset_code_rejects_everyone(self):
        with mock.patch.dict(os.environ, {"INVITE_CODE": ""}):
            with self.assertRaises(Exception):
                presignup.lambda_handler(self.ev(""), None)

    def test_admin_created_users_need_no_code(self):
        with mock.patch.dict(os.environ, {"INVITE_CODE": "correct-horse-42"}):
            presignup.lambda_handler(self.ev(None, source="PreSignUp_AdminCreateUser"), None)


# ------------------------------------------------------------------ (e) metrics
def w(date, exercise="Bench press", sets=((5, 60),), status="completed"):
    return {"date": date, "status": status,
            "exercises": [{"name": exercise, "sets": [{"reps": r, "weight": wt} for r, wt in sets]}]}


class MetricTests(unittest.TestCase):
    def test_goal_progress_types(self):
        ws = [w("2026-10-01", sets=((5, 80), (0, 120))), w("2026-10-05", sets=((1, 95),)),
              w("2026-10-06", "Squat", ((10, 100),)), w("2026-10-07", status="planned", sets=((1, 200),))]
        weight = handler.goal_progress({"type": "weight", "exercise": "bench press", "target": 100}, ws)
        self.assertEqual((weight["value"], weight["pct"]), (95.0, 95.0))  # 0-rep and planned ignored
        e1rm = handler.goal_progress({"type": "e1rm", "exercise": "Bench press", "target": 100}, ws)
        self.assertEqual(e1rm["value"], 95.0)  # max(80*(1+5/30)=93.3, 95 single)
        week = handler.goal_progress({"type": "perWeek", "target": 4}, ws, on="2026-10-07")  # Wed; Mon 5th
        self.assertEqual(week["value"], 2.0)
        self.assertEqual(week["pct"], 50.0)
        vol = handler.goal_progress({"type": "volume", "target": 1000, "startDate": "2026-10-05",
                                     "endDate": "2026-10-31"}, ws)
        self.assertEqual(vol["value"], 95 + 1000)
        self.assertEqual(vol["pct"], 100.0)  # capped

    def test_comp_workouts_and_volume(self):
        ws = [w("2026-09-30"), w("2026-10-01"), w("2026-10-03", sets=((10, 50), (10, 50))), w("2026-10-09")]
        comp = {"startDate": "2026-10-01", "endDate": "2026-10-07"}
        self.assertEqual(handler.comp_score({**comp, "metric": "workouts"}, ws, on="2026-10-20"), 2.0)
        self.assertEqual(handler.comp_score({**comp, "metric": "volume"}, ws, on="2026-10-20"), 300 + 1000)

    def test_comp_e1rm_improvement_against_own_baseline(self):
        comp = {"metric": "e1rmPct", "exercise": "Bench press", "startDate": "2026-10-01", "endDate": "2026-10-31"}
        ws = [w("2026-09-20", sets=((1, 100),)), w("2026-10-10", sets=((1, 110),))]
        self.assertEqual(handler.comp_score(comp, ws, on="2026-11-01"), 10.0)
        # no history before the start: the first week is the baseline
        ws2 = [w("2026-10-02", sets=((1, 50),)), w("2026-10-20", sets=((1, 60),))]
        self.assertEqual(handler.comp_score(comp, ws2, on="2026-11-01"), 20.0)
        self.assertIsNone(handler.comp_score(comp, [], on="2026-11-01"))

    def test_comp_streak_of_weeks_hitting_target(self):
        comp = {"metric": "streak", "weeklyTarget": 2, "startDate": "2026-09-28", "endDate": "2026-10-25"}
        # weeks from Mon 28 Sep: 2, 1, 2, 2 sessions -> longest run 2
        dates = ["2026-09-28", "2026-09-30", "2026-10-06", "2026-10-12", "2026-10-14", "2026-10-19", "2026-10-21"]
        self.assertEqual(handler.comp_score(comp, [w(x) for x in dates], on="2026-11-01"), 2.0)

    def test_rank_shares_ties_and_puts_no_data_unranked(self):
        out = handler.rank([("a", 5.0), ("b", None), ("c", 9.0), ("d", 5.0), ("e", 0.0), ("f", -3.0)])
        self.assertEqual([(r, m) for r, m, _ in out], [(1, "c"), (2, "a"), (2, "d"), (None, "b"), (None, "e"), (None, "f")])
        self.assertTrue(all(s is None for r, _, s in out if r is None))  # no low scores on show


class GoalRouteTests(CrewBase):
    def test_goal_completes_once_and_posts_to_feed(self):
        me = self.profile("a", "Alex")
        goal = self.ok("POST /goals", "a", {"type": "weight", "exercise": "Bench press", "target": 70})
        self.assertEqual((goal["status"], goal["progress"]["pct"]), ("active", 0.0))
        self.log("a", d(0), sets=((3, 72.5),))
        goals = self.ok("GET /goals", "a")["items"]
        self.assertEqual(goals[0]["status"], "completed")
        self.ok("GET /goals", "a")
        feed = [f for f in self.ok("GET /crew", "a")["feed"] if f["kind"] == "goalDone"]
        self.assertEqual(len(feed), 1)
        self.assertEqual((feed[0]["actor"], feed[0]["label"]), (me["memberId"], "Bench press 70 kg"))

    def test_goal_validation(self):
        self.profile("a", "Alex")
        for body in ({"type": "bogus"}, {"type": "weight", "target": 100}, {"type": "perWeek", "target": 0},
                     {"type": "volume", "target": 5, "startDate": "2026-10-10", "endDate": "2026-10-01"},
                     {"type": "e1rm", "exercise": "Bench", "target": -1}):
            status, _ = call(event("POST /goals", sub="a", body=body))
            self.assertEqual(status, 400, body)

    def test_crew_routes_need_a_profile(self):
        for route in ("GET /crew", "GET /competitions"):
            status, _ = call(event(route, sub="nobody"))
            self.assertEqual(status, 409)


if __name__ == "__main__":
    unittest.main()
