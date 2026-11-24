"""
매일 돌리는 데이터 점검.

  python -m update.check                # src 폴더에서 실행
  python -m update.check --fixtures update/fixtures --today 2026-11-24   # 인터넷 없이 시험

하는 일
  1) 안산시청 고시·공고 새 글 수집 (지난번 본 글번호 이후)
  2) 규칙으로 1차 거르고, 남은 것만 LLM(또는 규칙)으로 분류
       - 이미 데이터에 있는 공고  → 버림
       - 기존 사업의 새 회차      → '업데이트' 제안 (신청기간·출처)
       - 처음 보는 청년 사업      → '추가' 제안 (사람이 거주유형 확인)
  3) 기존 52건 점검
       - 예상 모집 시기가 지났는데 새 공고가 없음 → '확인' 제안
       - 마감 후 1년 넘게 새 회차 없음           → '폐기' 제안
       - 사업 중단·폐지 문구                     → '확인' 제안
  4) review/queue.json (검수 대기열), review/SUMMARY.md (PR 본문), state/seen.json 저장

데이터 자체(src/overrides.json)는 바꾸지 않는다. 사람이 검수 화면에서 고른 결정만 반영된다.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

from . import board, rules
from .llm import LLM

SRC = Path(__file__).resolve().parent.parent
ROOT = SRC.parent


# ---------------- 입출력 ----------------
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class Source:
    """실제 시청 사이트 또는 시험용 fixtures 폴더."""

    def __init__(self, fixtures: Path | None):
        self.fx = fixtures

    def new_posts(self, last_seq, since):
        if not self.fx:
            return board.fetch_new_posts(last_seq, max_pages=10 if last_seq else 40, since=since)
        posts = []
        for f in sorted(self.fx.glob("list_page_*.html")):
            posts += board.parse_list(f.read_text(encoding="utf-8"))
        return [p for p in posts if (last_seq is None or p["seq"] > last_seq) and (not since or p["date"] >= since)]

    def detail(self, seq):
        if not self.fx:
            return board.fetch_detail(seq)
        f = self.fx / f"detail_{seq}.html"
        d = board.parse_detail(f.read_text(encoding="utf-8")) if f.exists() else {"title": "", "body": "", "files": []}
        d["seq"], d["url"] = seq, board.DETAIL_URL.format(seq=seq)
        return d

    def attachment(self, seq, file):
        if not self.fx:
            return board.fetch_attachment_text(file["fileId"])
        f = self.fx / f"attach_{seq}.txt"
        return f.read_text(encoding="utf-8") if f.exists() else ""

    def link_ok(self, url):
        if self.fx:
            return True
        try:
            page = board._get(url, retries=1)
        except board.FetchError:
            return False
        return not re.search(r"존재하지 않는|삭제된 게시물|잘못된 접근", page)


# ---------------- 제안 만들기 ----------------
EXPECT = re.compile(r"(?:예상|예정)\s*[:：]?\s*(20\d\d)\s*년\s*(\d{1,2})\s*월")
EXPECT_TAIL = re.compile(r"[.·]?\s*(?:다음|동계|하계|상반기|하반기)?\s*모집\s*예상\s*[:：]?\s*20\d\d\s*년\s*\d{1,2}\s*월")


def seq_of(url: str | None):
    m = re.search(r"bbs_seq=(\d+)", url or "")
    return int(m.group(1)) if m else None


def post_text(det: dict, att: str) -> str:
    return "\n".join(x for x in [det.get("title", ""), det.get("body", ""), att] if x)


def as_bool(v):
    """LLM이 true/false 대신 "false", "아니요" 같은 글자로 답해도 알아듣기. 모르면 None."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        t = v.strip().lower()
        if t in ("false", "no", "n", "아니요", "아니오", "거짓", "해당 없음", "0"):
            return False
        if t in ("true", "yes", "y", "예", "네", "참", "1"):
            return True
    return None


def build_post_item(post, det, text, matches, llm_out, by, today, policies_by_id):
    """공고 하나 → 대기열 항목 하나 (또는 None)."""
    year = int(post["date"][:4]) if post.get("date") else today.year
    rp = rules.extract_period(text, year)
    ra = rules.extract_age(text)
    rr = rules.guess_residence(text)
    best = matches[0] if matches else None

    lo = dict(llm_out or {})
    lo["relevant"], lo["youth"] = as_bool(lo.get("relevant")), as_bool(lo.get("youth"))
    if llm_out is not None and lo.get("relevant") is None:
        llm_out = None                     # 형식이 이상한 답은 믿지 않고 규칙으로 판단
        lo = {}
        by = "rules"
    if llm_out is not None and lo.get("relevant") is False:
        return None, f"LLM 제외: {lo.get('reason') or ''}".strip()

    match_id = lo.get("match_id") if lo.get("match_id") in policies_by_id else None
    if not match_id and best and best[2] >= rules.MATCH_THRESHOLD:
        match_id = best[0]
    if llm_out is None and not match_id and not rules.youth_signal(text):
        return None, "규칙: 청년 대상 신호 없음 (LLM 없이 보류)"
    if llm_out is not None and lo.get("youth") is False and not match_id:
        return None, f"LLM: 청년 대상 아님 ({lo.get('reason') or ''})".strip()

    la = lo.get("apply") or {}
    start = la.get("start") or (rp or {}).get("start")
    end = la.get("end") or (rp or {}).get("end")
    period_quote = la.get("periodText") or (rp or {}).get("quote")
    evidence = lo.get("evidence") or ""
    ev_ok = rules.evidence_in(evidence, text) if evidence else False
    if not ev_ok:
        # LLM 인용이 원문에 없으면 쓰지 않고, 규칙이 찾은 원문 조각으로 대신
        evidence = (rp or {}).get("quote") or ra.get("quote") or ""
        ev_ok = rules.evidence_in(evidence, text) if evidence else False

    src = {"seq": post["seq"], "url": post["url"], "title": post["title"], "date": post.get("date"),
           "dept": post.get("dept"), "noticeNo": post.get("noticeNo") or det.get("noticeNo")}
    notes = []
    if not start or not end:
        notes.append("신청기간을 원문에서 찾지 못했어요. 직접 입력해 주세요.")
    if start and end and start > end:
        notes.append("시작일이 마감일보다 늦어요. 확인해 주세요.")
        start = end = None

    if match_id:
        cur = policies_by_id[match_id]
        old_pt = cur["apply"].get("periodText") or ""
        # '연 2회(5월·11월 모집)'처럼 반복 일정을 설명하는 문구는 살리고(예상 시기만 지움),
        # '2026 모집 종료'처럼 지난 회차 이야기면 새 공고의 기간 문구로 바꾼다
        if re.search(r"연\s*\d\s*회|매년|분기|상시|연중|수시", old_pt):
            new_pt = EXPECT_TAIL.sub("", old_pt).strip(" .·")
        else:
            new_pt = period_quote or ""
        after = {"apply": {"start": start, "end": end, "periodText": new_pt}, "sourceUrl": post["url"]}
        la_age = lo.get("age") or {}
        new_age = {"min": la_age.get("min") if la_age else ra.get("min"), "max": la_age.get("max") if la_age else ra.get("max")}
        if (new_age["min"] or new_age["max"]) and (new_age["min"], new_age["max"]) != (cur["age"]["min"], cur["age"]["max"]):
            notes.append(f"나이 조건이 바뀌었을 수 있어요: 지금 {cur['age']['min']}~{cur['age']['max']}세 → 공고 {new_age['min']}~{new_age['max']}세")
        r_type = (lo.get("residence") or {}).get("type") or rr["type"]
        if r_type not in ("R9", None) and r_type != cur["residence"]["type"]:
            notes.append(f"거주 유형이 바뀌었을 수 있어요: 지금 {cur['residence']['type']} → 공고 {r_type}")
        score = next((sc for i, _, sc in matches if i == match_id), 0.0)
        # 날짜는 규칙이 원문에서 직접 뽑은 값과 같을 때만 '확인됨'
        dates_ok = bool(rp and start and end and rp.get("start") == start and rp.get("end") == end
                        and rules.evidence_in(rp["quote"], text))
        return {
            "key": f"post-{post['seq']}", "kind": "update", "policyId": match_id,
            "matchScore": score, "datesVerified": dates_ok, "periodQuote": (rp or {}).get("quote"),
            "title": f"{cur['name']} — 새 공고",
            "reason": lo.get("reason") or f"이름이 기존 사업과 비슷해요 (유사도 {best[2] if best else '-'})",
            "source": src, "evidence": evidence, "evidenceVerified": ev_ok,
            "before": {"apply": cur["apply"], "sourceUrl": cur["sourceUrl"]},
            "after": after, "notes": notes, "by": by, "createdAt": today.isoformat(),
            "options": ["apply", "keep", "ignore"],
        }, None

    r_type = (lo.get("residence") or {}).get("type") or rr["type"]
    if r_type not in rules.RESIDENCE_TYPES:
        r_type = "R9"
        notes.append("거주 유형을 정하지 못했어요. 검수할 때 꼭 골라 주세요.")
    la_age = lo.get("age") or {}
    draft = {
        "id": f"NEW{post['seq']}",
        "name": lo.get("name") or rules.norm_name(post["title"]) or post["title"],
        "category": lo.get("category") if lo.get("category") in ("교육일자리", "주거복지", "참여권리", "문화예술")
                    else rules.guess_category(text),
        "residence": {"type": r_type},
        "age": {"min": la_age.get("min", ra.get("min")), "max": la_age.get("max", ra.get("max"))},
        "benefit": lo.get("benefit") or "",
        "apply": {"start": start, "end": end, "periodText": period_quote or "", "url": None},
        "otherConditions": [c for c in (lo.get("otherConditions") or []) if isinstance(c, str)][:5],
        "bonus": None,
        "evidence": evidence,
        "sourceUrl": post["url"],
    }
    if not draft["benefit"]:
        notes.append("혜택 설명이 비어 있어요. 한 줄로 적어 주세요.")
    return {
        "key": f"post-{post['seq']}", "kind": "add", "policyId": None,
        "title": draft["name"],
        "reason": lo.get("reason") or "청년 대상 모집 공고로 보여요 (규칙)",
        "source": src, "evidence": evidence, "evidenceVerified": ev_ok,
        "before": None, "after": draft, "notes": notes, "by": by, "createdAt": today.isoformat(),
        "options": ["apply", "ignore"],
        "related": [{"id": i, "name": n, "score": s} for i, n, s in matches[:3]],
    }, None


AUTO_MATCH = 0.75


def auto_update_ok(item, today) -> tuple[bool, str]:
    """기간 업데이트를 사람 없이 반영해도 되는지. 하나라도 걸리면 검수 대기열로."""
    if item["kind"] != "update":
        return False, "업데이트 아님"
    a, b = item["after"]["apply"], item["before"]["apply"]
    if not item.get("datesVerified"):
        return False, "신청기간을 원문에서 확인하지 못함"
    if item.get("notes"):
        return False, "나이·거주 조건 변경 등 확인할 점이 있음"
    if item.get("matchScore", 0) < AUTO_MATCH:
        return False, f"기존 사업과 이름이 충분히 같지 않음 (유사도 {item.get('matchScore')})"
    if b.get("end") and a["end"] <= b["end"]:
        return False, "지금 데이터보다 새 회차가 아님"
    return True, ""


def add_ready(item) -> tuple[bool, str]:
    """새 사업 초안이 사람 손 안 대고 'Merge 하면 추가' 해도 될 만큼 채워졌는지."""
    a = item["after"]
    if not item["by"].startswith("llm:"):
        return False, "규칙만으로는 자격조건을 다 읽지 못함"
    if a["residence"]["type"] not in rules.RESIDENCE_TYPES:
        return False, "거주 유형 미정"
    if a["residence"]["type"] in ("R2", "R6"):
        return False, "거주 연수나 대상 학교·직장은 사람이 확인해야 함"
    if not (a.get("benefit") or "").strip():
        return False, "혜택 설명 없음"
    ap_ = a["apply"]
    if not ap_.get("start") or not ap_.get("end") or ap_["start"] > ap_["end"]:
        return False, "신청기간 불확실"
    if not item.get("evidenceVerified"):
        return False, "근거 문장을 원문에서 확인 못 함"
    if item.get("notes"):
        return False, "확인할 점이 있음"
    return True, ""


def audit(policies, today, pending_update_ids, source, check_links):
    items = []
    q = (today.month - 1) // 3 + 1
    for p in policies:
        a, pid = p["apply"], p["id"]
        end = date.fromisoformat(a["end"]) if a.get("end") else None
        start = date.fromisoformat(a["start"]) if a.get("start") else None
        pt = a.get("periodText") or ""
        base = {"policyId": pid, "before": {"apply": a, "sourceUrl": p["sourceUrl"]}, "after": None,
                "source": {"url": p["sourceUrl"], "title": p["name"]}, "evidence": "", "evidenceVerified": False,
                "notes": [], "by": "rules", "createdAt": today.isoformat()}
        closed = end is not None and end < today
        m = EXPECT.search(pt)
        if m and pid not in pending_update_ids:
            exp = date(int(m.group(1)), int(m.group(2)), 1)
            if exp <= today and (closed or end is None):
                items.append(dict(base, key=f"audit-{pid}-expected-{exp:%Y-%m}", kind="check",
                                  title=p["name"],
                                  reason=f"예상 모집 시기({exp.year}년 {exp.month}월)가 됐는데 새 공고를 아직 못 찾았어요. "
                                         f"안산시청에서 직접 확인하고, 새 공고가 있으면 '추가 메모'에 주소를 남겨 주세요.",
                                  options=["keep", "retire"]))
        if end and (today - end).days > 365 and pid not in pending_update_ids:
            items.append(dict(base, key=f"audit-{pid}-stale", kind="retire", title=p["name"],
                              reason=f"마지막 마감일({end.isoformat()}) 뒤 1년 넘게 새 회차가 없어요. 사업이 끝났는지 확인해 주세요.",
                              options=["retire", "keep"]))
        halted = re.search(r"중단|폐지|사업\s*종료", pt)
        if halted:
            items.append(dict(base, key=f"audit-{pid}-halt-{today.year}", kind="check", title=p["name"],
                              reason=f"안내 문구에 '{halted.group(0)}'이 있어요: “{pt}” 계속 보여줄지 정해 주세요.",
                              options=["keep", "retire"]))
        if (not start and not end and not re.search(r"상시|연중", pt)
                and not halted and pid not in pending_update_ids):
            items.append(dict(base, key=f"audit-{pid}-nodate-{today.year}Q{q}", kind="check", title=p["name"],
                              reason="신청기간 날짜가 없어서 마감 여부를 판정할 수 없어요. 분기에 한 번 원문을 확인해 주세요."
                                     + (f" (안내: {pt})" if pt else ""),
                              options=["keep", "retire"]))
        if check_links and not source.link_ok(p["sourceUrl"]):
            wk = today.isocalendar()
            items.append(dict(base, key=f"audit-{pid}-link-{wk[0]}W{wk[1]:02d}", kind="check", title=p["name"],
                              reason="출처 링크가 열리지 않아요. 페이지가 옮겨졌거나 삭제됐을 수 있어요.",
                              options=["keep", "retire"]))
    return items


# ---------------- 요약 ----------------
KIND_LABEL = {"update": "기간 업데이트", "add": "새 사업", "retire": "폐기 검토", "check": "확인 필요"}


def summary_md(queue, new_items, stats, today, review_url, auto_applied=()):
    lines = [f"# 데이터 검수 요청 ({today.isoformat()})", ""]
    lines.append(f"- 새로 확인한 고시·공고: **{stats['posts']}건** → 모집성 공고 {stats['candidates']}건 → "
                 f"검수 대기열에 새로 {len(new_items)}건")
    lines.append(f"- 분류: {stats['classifier']}" + (f" (LLM 오류 {stats['llm_errors']}회 → 규칙으로 대신함)" if stats['llm_errors'] else ""))
    if stats.get("fetch_error"):
        lines.append(f"- ⚠️ 안산시청 사이트를 읽지 못했어요: {stats['fetch_error']}")
    lines.append(f"- 지금 대기 중인 항목: **{len(queue)}건** "
                 + " · ".join(f"{KIND_LABEL[k]} {sum(1 for i in queue if i['kind'] == k)}" for k in KIND_LABEL))
    lines += ["", f"👉 **검수 화면:** {review_url}", "",
              "**새 사업 중 'Merge 하면 추가'라고 적힌 것은 자동으로 다 채워져 있어요. 내용을 보고 괜찮으면 이 PR을 Merge 하는 것이 최종 승인이에요.** "
              "빼거나 고칠 것, '칸 채우기 필요'·폐기·확인 항목이 있을 때만 검수 화면에서 고르고 `overrides.json`을 "
              "이 PR 브랜치(`data-review`)의 `src/`에 올리세요.", ""]
    if auto_applied:
        lines += [f"## ✅ 자동 반영한 기간 업데이트 ({len(auto_applied)})", "",
                  "원문에서 신청기간을 확인했고, 기존 사업과 이름이 같고, 나이·거주 조건이 그대로라서 검수 없이 바로 반영했어요 "
                  "(main 브랜치에 바로 올라가서 사이트에 나와요). 틀렸으면 검수 화면에서 해당 사업을 다시 고치면 돼요.", "",
                  "| 사업 | 신청기간 | 원문 근거 |", "|---|---|---|"]
        for i in auto_applied:
            b, a = i["before"]["apply"], i["after"]["apply"]
            q = (i.get("periodQuote") or "").replace("|", "/")
            lines.append(f"| {i['policyId']} {i['title'].replace(' — 새 공고', '')} | {b.get('start')}~{b.get('end')} → "
                         f"**{a['start']}~{a['end']}** | [{q}]({i['source']['url']}) |")
        lines.append("")
    for kind in KIND_LABEL:
        rows = [i for i in queue if i["kind"] == kind]
        if not rows:
            continue
        lines += [f"## {KIND_LABEL[kind]} ({len(rows)})", "", "| 항목 | 내용 | 출처 |", "|---|---|---|"]
        for i in rows:
            what = i["reason"].replace("|", "/")
            if kind == "update":
                b, a = i["before"]["apply"], i["after"]["apply"]
                what = f"{b.get('start')}~{b.get('end')} → **{a.get('start')}~{a.get('end')}**"
            elif kind == "add":
                a = i["after"]
                what = (("**Merge 하면 추가** · " if i.get("staged") else "⚠ 칸 채우기 필요 · ") +
                        f"{a['category']} · {a['residence']['type']} · {a['age']['min']}~{a['age']['max']}세 · "
                        f"{a['apply']['start']}~{a['apply']['end']} · {a.get('benefit') or ''}")
            src = i.get("source") or {}
            new = " 🆕" if i in new_items else ""
            lines.append(f"| {i.get('policyId') or ''} {i['title']}{new} | {what} | [{src.get('date') or '원문'}]({src.get('url')}) |")
        lines.append("")
    if stats["skipped"]:
        lines += ["<details><summary>모집성 공고였지만 대기열에 안 넣은 것 "
                  f"({len(stats['skipped'])}건)</summary>", ""]
        lines += [f"- {t} — {why}" for t, why in stats["skipped"]] + ["", "</details>"]
    return "\n".join(lines) + "\n"


# ---------------- 실행 ----------------
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", help="기준일 YYYY-MM-DD (기본: 오늘, 한국 시간)")
    ap.add_argument("--fixtures", type=Path, help="인터넷 대신 쓸 시험용 HTML 폴더")
    ap.add_argument("--policies", type=Path, default=SRC / "policies_v3.json")
    ap.add_argument("--overrides", type=Path, default=SRC / "overrides.json")
    ap.add_argument("--auto-overrides", type=Path, default=SRC / "overrides.auto.json",
                    help="사람 검수 없이 반영한 기간 업데이트가 쌓이는 파일")
    ap.add_argument("--no-auto", action="store_true", help="기간 업데이트도 전부 사람이 검수")
    ap.add_argument("--staged", type=Path, default=SRC / "overrides.new.json",
                    help="자동으로 다 채운 새 사업 초안. 검수 PR을 Merge 하면 추가된다")
    ap.add_argument("--merged-staged", type=Path,
                    help="main에 이미 Merge된 overrides.new.json (여기 있는 새 사업은 대기열에서 정리)")
    ap.add_argument("--queue", type=Path, default=ROOT / "review" / "queue.json")
    ap.add_argument("--summary", type=Path, default=ROOT / "review" / "SUMMARY.md")
    ap.add_argument("--state", type=Path, default=ROOT / "state" / "seen.json")
    ap.add_argument("--check-links", action="store_true", help="출처 링크가 열리는지도 확인 (주 1회 권장)")
    ap.add_argument("--review-url", default="https://chang-kyu.github.io/aix-teamplay/review/")
    args = ap.parse_args(argv)

    today = date.fromisoformat(args.today) if args.today else (date.today() if args.fixtures else _kst_today())
    policies = load_json(args.policies, {})["policies"]
    by_id = {p["id"]: p for p in policies}
    ov = load_json(args.overrides, {})
    auto = load_json(args.auto_overrides, {})
    auto.setdefault("version", 1); auto.setdefault("updates", {}); auto.setdefault("decided", {})
    decided = {**auto["decided"], **ov.get("decided", {})}
    auto_applied = []
    staged = load_json(args.staged, {})
    staged.setdefault("version", 1); staged.setdefault("added", [])
    staged_now = []
    old_queue = load_json(args.queue, {"items": []}).get("items", [])
    state = load_json(args.state, {})
    source = Source(args.fixtures)
    llm = LLM()

    known_seqs = {seq_of(p["sourceUrl"]) for p in policies} | {seq_of(p.get("sourceUrl")) for p in ov.get("added", [])}
    known_seqs |= {int(k.split("-")[1]) for k in decided if k.startswith("post-")}
    known_seqs |= {seq_of(a.get("sourceUrl")) for a in staged["added"]}
    merged_ids = {a["id"] for a in load_json(args.merged_staged, {}).get("added", [])} if args.merged_staged else set()
    queue = [i for i in old_queue if i["key"] not in decided and (not i.get("policyId") or i["policyId"] in by_id)
             and not (i.get("staged") and i["after"]["id"] in merged_ids)]
    queued_keys = {i["key"] for i in queue}

    stats = {"posts": 0, "candidates": 0, "skipped": [], "llm_errors": 0, "fetch_error": None,
             "classifier": (f"{llm.label} + 규칙" if llm.enabled else "규칙만 (LLM_API_KEY 없음)")}
    new_items = []
    last_seq = state.get("lastSeq")
    since = None if last_seq else (today - timedelta(days=30)).isoformat()
    try:
        posts = source.new_posts(last_seq, since)
    except board.FetchError as e:
        posts, stats["fetch_error"] = [], str(e)[:300]
    stats["posts"] = len(posts)

    for post in sorted(posts, key=lambda p: p["seq"]):
        if post["seq"] in known_seqs or f"post-{post['seq']}" in queued_keys:
            continue
        if not rules.is_candidate(post["title"]):
            continue
        stats["candidates"] += 1
        try:
            det = source.detail(post["seq"])
            f = board.pick_notice_file(det.get("files", []))
            att = source.attachment(post["seq"], f) if f else ""
        except board.FetchError as e:
            det, att = {"title": post["title"], "body": ""}, ""
            stats["skipped"].append((post["title"], f"원문을 읽지 못함 ({str(e)[:60]})"))
        text = post_text(det, att) or post["title"]
        matches = rules.match_policies(post["title"], policies)
        llm_out = llm.classify(post, text, matches)
        by = llm.label if llm_out is not None else "rules"
        item, why = build_post_item(post, det, text, matches, llm_out, by, today, by_id)
        if item and not args.no_auto and auto_update_ok(item, today)[0]:
            pid = item["policyId"]
            auto["updates"][pid] = {"apply": item["after"]["apply"], "sourceUrl": item["after"]["sourceUrl"],
                                    "from": item["key"], "at": today.isoformat(), "auto": True}
            auto["decided"][item["key"]] = {"decision": "apply", "at": today.isoformat(), "kind": "update",
                                            "policyId": pid, "auto": True, "by": item["by"]}
            by_id[pid] = {**by_id[pid], "apply": {**by_id[pid]["apply"], **item["after"]["apply"]},
                          "sourceUrl": item["after"]["sourceUrl"]}
            policies = [by_id.get(p["id"], p) for p in policies]
            auto_applied.append(item)
            continue
        if item and item["kind"] == "add" and not args.no_auto and add_ready(item)[0]:
            draft = dict(item["after"], _from=item["key"], _by=item["by"], _at=today.isoformat())
            staged["added"] = [x for x in staged["added"] if x["id"] != draft["id"]] + [draft]
            item = dict(item, staged=True, options=["apply", "ignore"],
                        reason="자격조건까지 자동으로 채웠어요. 검수 PR을 Merge 하면 추가돼요. 빼려면 '무시', 고치려면 칸을 고치고 '반영'.")
            staged_now.append(item)
        if item:
            queue.append(item)
            new_items.append(item)
            queued_keys.add(item["key"])
        else:
            stats["skipped"].append((post["title"], why))
    stats["llm_errors"] = len(llm.errors)

    pending_update_ids = {i["policyId"] for i in queue if i["kind"] == "update"} | {i["policyId"] for i in auto_applied}
    # 새 회차 공고를 찾은 사업의 '예상 시기인데 공고 못 찾음' 확인 항목은 이제 필요 없다
    queue = [i for i in queue if not (i["kind"] == "check" and "-expected-" in i["key"] and i.get("policyId") in pending_update_ids)]
    for item in audit(policies, today, pending_update_ids, source, args.check_links):
        if item["key"] in decided or item["key"] in queued_keys:
            continue
        queue.append(item)
        new_items.append(item)
        queued_keys.add(item["key"])

    order = {"update": 0, "add": 1, "retire": 2, "check": 3}
    queue.sort(key=lambda i: (order[i["kind"]], i.get("source", {}).get("date") or "", i["key"]))
    save_json(args.queue, {"generatedAt": today.isoformat(), "classifier": stats["classifier"],
                           "llmErrors": llm.errors, "items": queue})
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    if auto_applied:
        auto["asOf"] = today.isoformat()
        save_json(args.auto_overrides, auto)
    if staged_now:
        save_json(args.staged, staged)
    args.summary.write_text(summary_md(queue, new_items, stats, today, args.review_url, auto_applied), encoding="utf-8")
    if posts:
        state["lastSeq"] = max(max(p["seq"] for p in posts), last_seq or 0)
    state["lastRun"] = today.isoformat()
    save_json(args.state, state)

    print(f"새 글 {stats['posts']} · 모집성 {stats['candidates']} · 자동 반영 {len(auto_applied)} · 새 사업 준비 {len(staged_now)} · 새 항목 {len(new_items)} · 대기 {len(queue)} · {stats['classifier']}")
    if stats["fetch_error"]:
        print("사이트 읽기 실패:", stats["fetch_error"], file=sys.stderr)
        return 2
    return 0


def _kst_today():
    from datetime import datetime, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=9)).date()


if __name__ == "__main__":
    sys.exit(main())
