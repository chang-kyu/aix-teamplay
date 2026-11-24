"""데이터 점검 시스템 테스트 (인터넷 없이).  src 폴더에서:  python -m unittest discover -s update -t ."""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from update import board, check, rules

HERE = Path(__file__).resolve().parent
FX = HERE / "fixtures"
SRC = HERE.parent


def base_policies():
    """검수 결정(overrides.json)과 상관없이 원본 52건으로 시험한다."""
    import build_v3
    return build_v3.build()


class Rules(unittest.TestCase):
    def test_candidate_filter_on_real_titles(self):
        yes = ["2027년 동계 청년 행정체험연수 참여자 모집공고", "2027년 청년어촌정착지원 사업 대상자 모집 공고",
               "시민 파워셀러 특강 '네이버 스마트스토어 활용 마케팅 교육' 수강생 모집 공고", "청년 노동자 통장 참여자 모집"]
        no = ["2026년 신길동 통장(8, 30, 32, 33, 34통) 공개모집 공고", "본오1동 주민자치센터 프로그램 강사 모집공고",
              "2027년 안산시 청년센터 상상스테이션 기간제근로자 공개채용 공고", "도로점용허가 내용 공고 [단원 제2026-195호]",
              "안산시 청년몰 소소플래닛 운영 수탁기관 선정 결과 공고", "「2026년 안산시 청년기본소득」 4분기 지급일자 변경 공고",
              "제목 시립어린이집 민간위탁 운영자 모집 재공고", "2026년 사물인터넷(IoT)측정기기 부착지원사업 참여 사업자 모집 마감 공고"]
        for t in yes:
            self.assertTrue(rules.is_candidate(t), t)
        for t in no:
            self.assertFalse(rules.is_candidate(t), t)

    def test_period_and_age(self):
        t = "○ 신청기간 : 2026. 11. 18.(수) 10:00 ∼ 11. 26.(목) 18:00\n○ 신청자격 : 안산시에 주민등록이 되어있는 19~39세 청년"
        p = rules.extract_period(t, 2026)
        self.assertEqual((p["start"], p["end"]), ("2026-11-18", "2026-11-26"))
        self.assertTrue(rules.evidence_in(p["quote"], t))
        self.assertEqual(rules.extract_age(t)["max"], 39)
        self.assertEqual(rules.extract_age("만 18세 이상 ~ 만 40세 미만")["max"], 39)
        self.assertEqual(rules.guess_residence(t)["type"], "R1")
        p2 = rules.extract_period("신청기간 : 2026. 12. 20. ~ 2027. 1. 9.", 2026)
        self.assertEqual((p2["start"], p2["end"]), ("2026-12-20", "2027-01-09"))

    def test_matching(self):
        pol = base_policies()
        self.assertEqual(rules.match_policies("2027년 동계 청년 행정체험연수 참여자 모집공고", pol)[0][0], "ANS013")
        self.assertEqual(rules.match_policies("2027년 청년어촌정착지원 사업 대상자 모집 공고", pol)[0][0], "ANS025")
        top = rules.match_policies("2027년 노인일자리 및 사회활동 지원사업 참여자 모집 공고", pol)[0]
        self.assertLess(top[2], rules.MATCH_THRESHOLD, top)

    def test_llm_answer_words_as_booleans(self):
        self.assertIs(check.as_bool("false"), False)
        self.assertIs(check.as_bool("아니요"), False)
        self.assertIs(check.as_bool(True), True)
        self.assertIsNone(check.as_bool("청년 개인이 신청할 수 있는가"))   # 질문을 그대로 베낀 답

    def test_evidence_check(self):
        src = "공고일 기준 안산시에 주민등록이 되어있는 19~39세 청년 또는 대학생"
        self.assertTrue(rules.evidence_in("안산시에 주민등록이 되어 있는 19~39세", src))
        self.assertFalse(rules.evidence_in("안산시에 1년 이상 거주한 청년", src))


class Board(unittest.TestCase):
    def test_parse(self):
        posts = board.parse_list((FX / "list_page_1.html").read_text(encoding="utf-8"))
        self.assertEqual(len(posts), 27)
        self.assertEqual(posts[0]["seq"], 1689380)
        d = board.parse_detail((FX / "detail_1687885.html").read_text(encoding="utf-8"))
        self.assertEqual(d["dept"], "청년정책관")
        self.assertEqual(board.pick_notice_file(d["files"])["name"], "2027년 동계 청년 행정체험연수 모집공고문.hwpx")


def run_check(tmp, env=None, extra=()):
    q, s, m = Path(tmp) / "queue.json", Path(tmp) / "seen.json", Path(tmp) / "SUMMARY.md"
    ov = Path(tmp) / "overrides.json"
    if not ov.exists():
        ov.write_text("{}", encoding="utf-8")
    pol = Path(tmp) / "policies.json"
    pol.write_text(json.dumps({"policies": base_policies()}, ensure_ascii=False), encoding="utf-8")
    old = {k: os.environ.get(k) for k in ("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL")}
    os.environ.pop("LLM_API_KEY", None)
    os.environ.update(env or {})
    try:
        code = check.main(["--fixtures", str(FX), "--today", "2026-11-24", "--queue", str(q), "--state", str(s),
                           "--summary", str(m), "--overrides", str(ov), "--policies", str(pol),
                           "--auto-overrides", str(Path(tmp) / "auto.json"),
                           *([] if "--staged" in extra else ["--staged", str(Path(tmp) / "new.json")]), *extra])
    finally:
        for k, v in old.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
    return code, json.loads(q.read_text(encoding="utf-8"))["items"], m.read_text(encoding="utf-8")


class Check(unittest.TestCase):
    def test_rules_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, items, summary = run_check(tmp, extra=["--no-auto"])
            self.assertEqual(code, 0)
            by = {i["key"]: i for i in items}
            up = by["post-1687885"]
            self.assertEqual((up["kind"], up["policyId"]), ("update", "ANS013"))
            self.assertEqual(up["after"]["apply"]["start"], "2026-11-18")
            self.assertEqual(up["after"]["apply"]["end"], "2026-11-26")
            self.assertTrue(up["evidenceVerified"])
            self.assertEqual(by["post-1688576"]["policyId"], "ANS025")
            self.assertEqual(by["post-1688576"]["notes"], [])          # 18~39세 그대로라 경고 없음
            self.assertEqual(by["post-1687420"]["kind"], "add")
            self.assertEqual(by["post-1687420"]["after"]["residence"]["type"], "R9")  # 사람이 골라야 함
            self.assertNotIn("post-1682678", by)                       # 이미 데이터에 있는 공고
            self.assertNotIn("post-1688191", by)                       # 노인일자리: 청년 신호 없음
            self.assertIn("audit-EXT015-stale", by)                    # 1년 넘게 새 회차 없음
            self.assertNotIn("audit-ANS001-nodate-2026Q4", by)        # 새 공고 제안이 있으면 중복 확인 안 함
            self.assertIn("데이터 검수 요청", summary)

    def test_auto_apply_verified_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, items, summary = run_check(tmp)
            keys = {i["key"] for i in items}
            auto = json.loads((Path(tmp) / "auto.json").read_text(encoding="utf-8"))
            # 날짜를 원문에서 확인 + 이름 같음 + 조건 그대로 → 사람 없이 반영
            self.assertEqual(auto["updates"]["ANS013"]["apply"]["end"], "2026-11-26")
            self.assertEqual(auto["updates"]["ANS025"]["apply"]["start"], "2026-11-17")
            self.assertTrue(auto["decided"]["post-1687885"]["auto"])
            self.assertNotIn("post-1687885", keys)
            self.assertIn("자동 반영한 기간 업데이트 (2)", summary)
            # 날짜를 못 찾은 업데이트·새 사업·폐기는 여전히 사람 검수
            self.assertIn("post-1688197", keys)
            self.assertIn("post-1687420", keys)
            self.assertIn("audit-EXT015-stale", keys)
            # 다음 날 다시 돌려도 같은 공고를 또 반영하지 않음
            (Path(tmp) / "seen.json").unlink()
            run_check(tmp)
            auto2 = json.loads((Path(tmp) / "auto.json").read_text(encoding="utf-8"))
            self.assertEqual(auto2["updates"], auto["updates"])

    def test_auto_skips_risky_updates(self):
        item = {"kind": "update", "datesVerified": True, "notes": [], "matchScore": 1.0,
                "before": {"apply": {"end": "2026-06-04"}}, "after": {"apply": {"start": "2026-11-18", "end": "2026-11-26"}}}
        from datetime import date
        self.assertTrue(check.auto_update_ok(item, date(2026, 11, 24))[0])
        for change in [{"datesVerified": False}, {"notes": ["나이 조건이 바뀌었을 수 있어요"]}, {"matchScore": 0.6},
                       {"before": {"apply": {"end": "2026-12-31"}}}]:
            self.assertFalse(check.auto_update_ok({**item, **change}, date(2026, 11, 24))[0], change)

    def test_decided_items_are_not_asked_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_check(tmp, extra=["--no-auto"])
            ov = {"decided": {"post-1687885": {"decision": "apply"}, "audit-EXT015-stale": {"decision": "keep"}}}
            (Path(tmp) / "overrides.json").write_text(json.dumps(ov), encoding="utf-8")
            (Path(tmp) / "seen.json").unlink()
            _, items, _ = run_check(tmp, extra=["--no-auto"])
            keys = {i["key"] for i in items}
            self.assertNotIn("post-1687885", keys)
            self.assertNotIn("audit-EXT015-stale", keys)
            self.assertIn("post-1688576", keys)


class FakeLLM(BaseHTTPRequestHandler):
    replies = {}

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user = body["messages"][1]["content"]
        title = user.split("[공고 제목] ")[1].split("\n")[0]
        content = self.replies.get(title, '{"relevant": false, "reason": "테스트: 관련 없음"}')
        if content == "ERROR":
            self.send_response(500); self.end_headers(); return
        out = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


class WithLLM(unittest.TestCase):
    def test_llm_path_and_hallucination_guard(self):
        FakeLLM.replies = {
            "시민 파워셀러 특강 '네이버 스마트스토어 활용 마케팅 교육' 수강생 모집 공고": json.dumps({
                "relevant": True, "youth": True, "match_id": None, "name": "시민 파워셀러 특강",
                "category": "교육일자리", "benefit": "스마트스토어 마케팅 교육 무료",
                "apply": {"start": "2026-11-05", "end": "2026-11-26", "periodText": "2026. 11. 5. ~ 11. 26."},
                "age": {"min": None, "max": None}, "residence": {"type": "R1", "text": "안산시민"},
                "evidence": "온라인마케팅에 관심 있는 안산시민 등 80명(선착순)", "reason": "청년정책관 교육"}),
            "2027년 동계 청년 행정체험연수 참여자 모집공고": "<think>생각</think>" + json.dumps({
                "relevant": True, "youth": True, "match_id": "ANS013", "name": "청년 행정체험 연수",
                "apply": {"start": "2026-11-18", "end": "2026-11-26", "periodText": "2026. 11. 18. ~ 11. 26."},
                "age": {"min": 19, "max": 39}, "residence": {"type": "R1"},
                "evidence": "안산시에 1년 이상 거주한 청년",          # 원문에 없는 문장 (환각)
                "reason": "동계 모집"}),
            "2027년 청년어촌정착지원 사업 대상자 모집 공고": "ERROR",
        }
        srv = HTTPServer(("127.0.0.1", 0), FakeLLM)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                code, items, summary = run_check(tmp, {"LLM_API_KEY": "test", "LLM_BASE_URL": f"http://127.0.0.1:{srv.server_port}"},
                                                 extra=["--no-auto"])
        finally:
            srv.shutdown(); srv.server_close()
        by = {i["key"]: i for i in items}
        add = by["post-1687420"]
        self.assertEqual(add["after"]["residence"]["type"], "R1")
        self.assertTrue(add["evidenceVerified"])
        self.assertTrue(add["by"].startswith("llm:"))
        up = by["post-1687885"]
        self.assertEqual(up["policyId"], "ANS013")
        self.assertNotIn("1년 이상", up["evidence"])                   # 환각 인용은 버리고 원문 조각으로 대체
        self.assertTrue(up["evidenceVerified"])
        self.assertEqual(by["post-1688576"]["by"], "rules")            # LLM 오류 → 규칙으로 대신
        self.assertNotIn("post-1688191", by)                           # LLM이 관련 없다고 한 공고
        self.assertIn("LLM 오류 1회", summary)


class NewProgramMergeFlow(unittest.TestCase):
    def test_filled_new_program_waits_for_merge(self):
        FakeLLM.replies = {
            "시민 파워셀러 특강 '네이버 스마트스토어 활용 마케팅 교육' 수강생 모집 공고": json.dumps({
                "relevant": True, "youth": True, "match_id": None, "name": "시민 파워셀러 특강",
                "category": "교육일자리", "benefit": "스마트스토어 마케팅 교육 무료",
                "apply": {"start": "2026-11-05", "end": "2026-11-26", "periodText": "2026. 11. 5. ~ 11. 26."},
                "age": {"min": None, "max": None}, "residence": {"type": "R1", "text": "안산시민"},
                "evidence": "온라인마케팅에 관심 있는 안산시민 등 80명(선착순)", "reason": "청년정책관 교육"})}
        srv = HTTPServer(("127.0.0.1", 0), FakeLLM)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        env = {"LLM_API_KEY": "test", "LLM_BASE_URL": f"http://127.0.0.1:{srv.server_port}"}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                staged = Path(tmp) / "new.json"
                _, items, summary = run_check(tmp, env, extra=["--staged", str(staged)])
                new = json.loads(staged.read_text(encoding="utf-8"))
                self.assertEqual([a["id"] for a in new["added"]], ["NEW1687420"])        # 다 채워져서 준비됨
                item = {i["key"]: i for i in items}["post-1687420"]
                self.assertTrue(item["staged"])
                self.assertIn("Merge 하면 추가", summary)
                # Merge 된 뒤 다음 날: 대기열에서 정리되고 같은 공고를 또 만들지 않음
                (Path(tmp) / "seen.json").unlink()
                _, items2, _ = run_check(tmp, env, extra=["--staged", str(staged), "--merged-staged", str(staged)])
                self.assertNotIn("post-1687420", {i["key"] for i in items2})
                self.assertEqual(len(json.loads(staged.read_text(encoding="utf-8"))["added"]), 1)
        finally:
            srv.shutdown(); srv.server_close()

    def test_rules_only_new_program_needs_a_person(self):
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / "new.json"
            _, items, _ = run_check(tmp, extra=["--staged", str(staged)])
            self.assertFalse(staged.exists())                                         # 규칙만으론 준비 안 함
            self.assertFalse({i["key"]: i for i in items}["post-1687420"].get("staged"))

    def test_build_skips_ignored_or_human_edited(self):
        import build_v3
        new = {"added": [{"id": "NEW1", "_from": "post-1"}, {"id": "NEW2", "_from": "post-2"}, {"id": "NEW3", "_from": "post-3"}]}
        ov = {"decided": {"post-1": {"decision": "ignore"}}, "added": [{"id": "NEW2"}]}
        self.assertEqual([a["id"] for a in build_v3.staged_adds(new, ov)["added"]], ["NEW3"])
        self.assertNotIn("_from", build_v3.staged_adds(new, ov)["added"][0])


class BuildOverrides(unittest.TestCase):
    def test_apply(self):
        import build_v3
        base = build_v3.build()
        ov = {"updates": {"ANS013": {"apply": {"start": "2026-11-18", "end": "2026-11-26"},
                                     "sourceUrl": "https://example.test/1687885"}},
              "retired": {"EXT015": {"reason": "끝"}},
              "added": [{"id": "NEW1687420", "name": "시민 파워셀러 특강", "category": "교육일자리",
                         "residence": {"type": "R1"}, "age": {"min": None, "max": None}, "benefit": "무료 교육",
                         "apply": {"start": "2026-11-05", "end": "2026-11-26", "periodText": ""},
                         "evidence": "안산시민 등", "sourceUrl": "https://example.test/1687420"}]}
        out = build_v3.apply_overrides(base, ov)
        by = {p["id"]: p for p in out}
        self.assertEqual(len(out), len(base))                              # -1 폐기 +1 추가
        self.assertEqual(by["ANS013"]["apply"]["end"], "2026-11-26")
        self.assertEqual(by["ANS013"]["apply"]["url"], "https://apply.jobaba.net")   # 안 바꾼 칸은 유지
        self.assertNotIn("EXT015", by)
        self.assertEqual(by["NEW1687420"]["residence"]["label"], "안산 주민등록")
        # 사람 결정이 자동 반영보다 이긴다
        both = build_v3.apply_overrides(build_v3.apply_overrides(base, {"updates": {"ANS013": {"apply": {"end": "2026-11-26"}}}}),
                                        {"updates": {"ANS013": {"apply": {"end": "2026-11-30"}}}})
        self.assertEqual({p["id"]: p for p in both}["ANS013"]["apply"]["end"], "2026-11-30")
        with self.assertRaises(AssertionError):
            build_v3.apply_overrides(base, {"added": [dict(ov["added"][0], residence={"type": "R9"})]})


if __name__ == "__main__":
    unittest.main()
