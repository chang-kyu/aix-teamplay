"""
규칙 기반 도구: LLM 키가 없거나 LLM이 실패해도 시스템이 돌게 하는 기본 판단.

1. is_candidate(title)  : 제목만 보고 '사람을 모집·선발·접수하는 공고'인지 1차로 거른다
2. match_policies(...)  : 기존 사업과 이름이 비슷한지 점수를 매긴다 (새 회차 찾기)
3. extract_*            : 공고 본문에서 신청기간·나이·거주요건을 뽑는다
4. evidence_in(...)     : LLM이 '원문 인용'이라고 준 문장이 실제 원문에 있는지 확인
"""
from __future__ import annotations

import re
from datetime import date
from difflib import SequenceMatcher

# ---------- 1. 제목 1차 필터 ----------
# 실제 안산시청 고시·공고 600건(2026-10-26~11-24)을 보고 정함. 하루 20건 정도 올라오고
# 대부분 공시송달·도로점용·주민등록 최고공고 같은 행정 공고다.
INCLUDE = re.compile(
    r"모집|공모|선발|접수|신청|참여자|참가자|수강생|교육생|대상자|입주자|지원사업|장학|청년|대학생"
)
EXCLUDE = re.compile(
    r"공시송달|도로점용|도로지정|도로변경|도로구간|점용허가|직권조치|직권말소|무단전출|거주불명|사실조사|"
    r"주민등록증 발급|주민자치회 위원|통장|입찰|견적|결정고시|실시계획|열람|공람|과태료|압류|체납|독촉|"
    r"공매|행정처분|행정대집행|등록말소|폐업|담배소매|건축법|건물번호|지적|측량|보상|수용재결|환경영향|"
    r"개발행위|개발제한|정비사업|재건축|도시계획|도시관리계획|하천구역|소하천|적치물|방치|CCTV|행정예고|"
    r"합격자|선정 결과|선정결과|결과 공고|심의결과|평가결과|수상작|수상자|명단|"
    r"수탁|위탁|운영자|운영체|운영기관|제공기관|수행기관|사업자 모집|업체|가맹점|중도매인|"
    r"강사|자원봉사자|기간제|공무직|채용|상임단원|외부회계|시의회|의안|부의 안건|조례|세칙|지급일자"
)
# 청년 사업이 분명하면 EXCLUDE 단어가 섞여 있어도 살린다 (예: '청년 노동자 통장', '청년센터 … 채용'은 제외 유지)
YOUTH_STRONG = re.compile(r"청년(?!센터 .*채용)|대학생|장학")


def is_candidate(title: str) -> bool:
    t = title or ""
    if not INCLUDE.search(t):
        return False
    if EXCLUDE.search(t):
        # '청년 노동자 통장'처럼 청년 사업 이름 안에 제외 단어가 있는 경우만 살림
        return bool(re.search(r"청년\s*노동자\s*통장", t))
    return True


def youth_signal(text: str) -> bool:
    return bool(YOUTH_STRONG.search(text or ""))


# ---------- 2. 기존 사업과 이름 맞추기 ----------
_NOISE = re.compile(
    r"20\d\d\s*년?도?|제\s*\d+\s*(기|회|차)|[「」『』\[\]()'\"‘’“”·・,]|"
    r"상반기|하반기|동계|하계|추가\s*모집|재공고|연장|변경|"
    r"모집\s*공고|모집|공고|안내|신청|접수|참여자|참가자|대상자|수강생|교육생|사업|운영|공개|계획|실시|개최|및"
)


def norm_name(s: str) -> str:
    s = _NOISE.sub(" ", s or "")
    s = re.sub(r"(?<=[가-힣])(을|를|의|에|과|와)(?=\s)", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _bigrams(s: str) -> set:
    s = re.sub(r"\s+", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)} or {s}


def name_score(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    ba, bb = _bigrams(na), _bigrams(nb)
    jac = len(ba & bb) / len(ba | bb)
    contain = 1.0 if (re.sub(r"\s", "", na) in re.sub(r"\s", "", nb) or
                      re.sub(r"\s", "", nb) in re.sub(r"\s", "", na)) else 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    # 긴 고유 단어 하나가 통째로 겹치면 같은 사업일 가능성이 높다
    # ('청년활동협의체 위원 모집' ↔ '청년 참여기구 구성ㆍ운영(청년정책위원회·청년활동협의체·…)')
    flat_b = re.sub(r"\s", "", b or "")
    token = 0.75 if any(len(w) >= 5 and w in flat_b for w in na.split()) else 0.0
    return round(max(jac, seq, 0.9 * contain, token), 3)


def match_policies(title: str, policies: list[dict], top: int = 5) -> list[tuple[str, str, float]]:
    scored = [(p["id"], p["name"], name_score(title, p["name"])) for p in policies]
    scored.sort(key=lambda x: -x[2])
    return scored[:top]


MATCH_THRESHOLD = 0.6


# ---------- 3. 본문에서 뽑기 ----------
_DATE = re.compile(
    r"(?:(20\d\d)\s*[.년\-/]\s*)?(\d{1,2})\s*[.월\-/]\s*(\d{1,2})\s*[.일]?(?:\s*\([월화수목금토일]\))?"
)
_PERIOD_KEY = re.compile(r"(신청|접수|모집|응모|공모|원서)\s*(기간|일시|기한)")


def _mkdate(y, m, d, default_year):
    try:
        return date(int(y or default_year), int(m), int(d))
    except ValueError:
        return None


def extract_period(text: str, default_year: int) -> dict | None:
    """'신청기간 : 2026. 11. 18.(수) 10:00 ∼ 11. 26.(목) 18:00' → {start, end, quote}"""
    for km in _PERIOD_KEY.finditer(text or ""):
        seg = text[km.end(): km.end() + 160]
        seg_line = seg.split("\n")[0] if len(seg.split("\n")[0]) > 12 else seg
        ds, last_end = [], 0
        for m in _DATE.finditer(seg_line):
            y, mo, d = m.groups()
            # 두 번째 날짜는 연도를 생략하는 경우가 많아서('~ 11. 26.') 앞 날짜의 연도를 이어 쓴다
            dt = _mkdate(y, mo, d, ds[-1].year if ds else default_year)
            if dt:
                ds.append(dt)
                last_end = m.end()
            if len(ds) == 2:
                break
        if not ds:
            continue
        # 인용은 '신청기간 … 마지막 날짜(+시간)'까지만
        tail = re.match(r"\s*\d{1,2}:\d{2}", seg_line[last_end:])
        quote = (text[km.start(): km.end()] + seg_line[: last_end + (tail.end() if tail else 0)]).strip()
        if len(ds) == 2 and ds[0] <= ds[1] and (ds[1] - ds[0]).days <= 400:
            return {"start": ds[0].isoformat(), "end": ds[1].isoformat(), "quote": quote}
        if len(ds) == 1:
            return {"start": ds[0].isoformat(), "end": None, "quote": quote}
    return None


_AGE_RANGE = re.compile(r"(?:만\s*)?(\d{2})\s*세?\s*(?:이상)?\s*[~∼～\-]\s*(?:만\s*)?(\d{2})\s*세")
_AGE_UNDER = re.compile(r"(?:만\s*)?(\d{2})\s*세\s*(이하|미만)")
_AGE_OVER = re.compile(r"(?:만\s*)?(\d{2})\s*세\s*이상")


def extract_age(text: str) -> dict:
    t = text or ""
    m = _AGE_RANGE.search(t)
    if m and int(m.group(1)) < int(m.group(2)):
        hi = int(m.group(2))
        if re.match(r"\s*미만", t[m.end():]):      # '만 18세 이상 ~ 만 40세 미만' → 39세까지
            hi -= 1
        return {"min": int(m.group(1)), "max": hi, "quote": m.group(0)}
    lo = _AGE_OVER.search(t)
    hi = _AGE_UNDER.search(t)
    out = {"min": int(lo.group(1)) if lo else None, "max": None, "quote": None}
    if hi:
        out["max"] = int(hi.group(1)) - (1 if hi.group(2) == "미만" else 0)
    q = [x.group(0) for x in (lo, hi) if x]
    out["quote"] = " / ".join(q) or None
    return out


# 거주요건 유형 (docs/08 참고). R9 = 자동으로 정하지 못함 → 사람이 골라야 함
RESIDENCE_TYPES = {
    "R1": "안산 주민등록",
    "R2": "안산 거주기간 (연속 N년 또는 합산 M년)",
    "R4": "안산 주민등록 + 경기도 거주기간",
    "R6": "안산 주민등록 또는 안산 소재 학교·직장·사업장",
    "R7": "거주 무관",
    "R8": "경기도 거주",
    "R10": "안산 외 지역 거주자만",
}


def guess_residence(text: str) -> dict:
    t = re.sub(r"\s+", " ", text or "")
    if re.search(r"안산시?\s*외\s*(지역|타\s*시군)|타\s*시군\s*거주", t):
        return {"type": "R10", "why": "안산 외 거주 조건"}
    if re.search(r"(계속|연속)(하여)?\s*\d+\s*년\s*이상|\d+\s*년\s*이상\s*(계속|연속)?\s*(거주|주민등록)", t) and "안산" in t:
        return {"type": "R2", "why": "거주기간 조건"}
    if re.search(r"(재학|재직|소재\s*(학교|직장|대학|기업|사업장))", t) and re.search(r"안산.{0,15}주민등록|주민등록.{0,15}안산", t):
        return {"type": "R6", "why": "주민등록 또는 학교·직장"}
    if re.search(r"안산시?에\s*주민등록|주민등록상?\s*(주소|거주지)?.{0,6}안산|안산시?\s*거주", t):
        return {"type": "R1", "why": "안산 주민등록"}
    if re.search(r"(경기도|도내)\s*(에\s*)?(거주|주민등록)", t):
        return {"type": "R8", "why": "경기도 거주"}
    if re.search(r"거주지\s*(제한\s*)?(없음|무관)|누구나|전\s*국민|전국\s*(청년|대학생)", t):
        return {"type": "R7", "why": "거주 무관"}
    return {"type": "R9", "why": "원문에서 거주 조건을 자동으로 찾지 못함 — 직접 확인"}


def guess_category(text: str) -> str:
    t = text or ""
    if re.search(r"월세|전세|주거|주택|임대|입주", t): return "주거복지"
    if re.search(r"공모|위원|패널|협의체|조사원|조사요원|서포터즈|기자단", t): return "참여권리"
    if re.search(r"문화|예술|축제|공연|관광|전시|DJ", t): return "문화예술"
    return "교육일자리"


# ---------- 4. 원문 인용 확인 ----------
def _squash(s: str) -> str:
    return re.sub(r"[\s ·・.,:()\[\]「」'\"‘’“”~∼～\-]", "", s or "")


def evidence_in(quote: str, source: str) -> bool:
    q = _squash(quote)
    return bool(q) and len(q) >= 6 and q in _squash(source)
