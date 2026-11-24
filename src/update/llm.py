"""
LLM 분류기 (OpenAI 호환 API).

기본값은 무료 Open AI Service Hub(https://open.hasa.re.kr/v1, 개발키 하루 성공 호출 500건).
환경변수로 바꿀 수 있다:
  LLM_API_KEY   (없으면 LLM을 쓰지 않고 규칙만 사용)
  LLM_BASE_URL  (기본 https://open.hasa.re.kr/v1)
  LLM_MODEL     (기본 exaone-4.0-32b)

LLM은 '후보 정리'만 한다. 판정(충족/미충족)은 여전히 judge.js 규칙이 하고,
LLM이 낸 값은 사람이 검수 화면에서 승인해야 데이터에 들어간다.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

DEFAULT_BASE = "https://open.hasa.re.kr/v1"
DEFAULT_MODEL = "exaone-4.0-32b"


class LLM:
    def __init__(self):
        self.key = os.environ.get("LLM_API_KEY", "").strip()
        self.base = (os.environ.get("LLM_BASE_URL") or DEFAULT_BASE).rstrip("/")
        self.model = os.environ.get("LLM_MODEL") or DEFAULT_MODEL
        self.calls = 0
        self.errors: list[str] = []
        self.max_calls = int(os.environ.get("LLM_MAX_CALLS", "60"))   # 하루 500건 한도 안에서 넉넉히

    @property
    def enabled(self) -> bool:
        return bool(self.key) and self.calls < self.max_calls and len(self.errors) < 3

    @property
    def label(self) -> str:
        return f"llm:{self.model}"

    def chat(self, system: str, user: str, max_tokens: int = 900) -> str:
        body = json.dumps({
            "model": self.model,
            "temperature": 0,
            "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }).encode()
        req = urllib.request.Request(self.base + "/chat/completions", data=body, headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.key}"})
        self.calls += 1
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode())
        return data["choices"][0]["message"]["content"]

    def classify(self, post: dict, text: str, candidates: list[tuple[str, str, float]]) -> dict | None:
        """공고 하나를 분류. 실패하면 None (호출한 쪽이 규칙으로 대신한다)."""
        if not self.enabled:
            return None
        cand = "\n".join(f"- {pid}: {name}" for pid, name, _ in candidates) or "- (없음)"
        user = USER_TMPL.format(title=post["title"], dept=post.get("dept", ""), date=post.get("date", ""),
                                candidates=cand, text=text[:6000])
        try:
            out = self.chat(SYSTEM, user)
            return parse_json(out)
        except Exception as e:
            self.errors.append(f"{type(e).__name__}: {e}"[:200])
            return None


def parse_json(s: str) -> dict:
    s = re.sub(r"(?s)<think>.*?</think>", "", s)          # 추론 모델의 생각 부분 제거
    m = re.search(r"(?s)\{.*\}", s)
    if not m:
        raise ValueError("JSON 없음")
    return json.loads(m.group(0))


SYSTEM = """너는 안산시청 고시·공고를 정리하는 도우미다. 청년(만 19~39세 전후) 개인이 신청할 수 있는
지원금·일자리·교육·공모전·참여 기회를 찾아 '안산시 혜택 알리미' 데이터 후보로 정리한다.

규칙:
- 반드시 JSON 하나만 출력한다. 설명 문장을 붙이지 않는다.
- 원문에 없는 내용은 지어내지 말고 null 로 둔다.
- evidence 칸에는 원문 문장을 한 글자도 바꾸지 말고 그대로 복사한다.
- 날짜는 YYYY-MM-DD. 원문에 연도가 생략된 마감일은 시작일의 연도를 따른다.
- 기관·업체·법인·단체를 모집하는 공고, 강사·직원 채용, 결과 발표, 행정 처분은 relevant=false.
- 기존 사업 목록 중 같은 사업의 새 회차(다음 해, 다음 학기, 추가 모집 등)이면 match_id 에 그 id를 넣는다."""

USER_TMPL = """[공고 제목] {title}
[담당부서] {dept}   [게시일] {date}

[기존 사업 목록 — 이름이 비슷한 순]
{candidates}

[공고 원문]
{text}

다음 JSON으로 답해:
{{
  "relevant": true/false,            // 청년 개인이 신청할 수 있는 혜택·기회인가
  "youth": true/false,               // 청년(19~39세 전후)이 대상에 포함되는가
  "match_id": "기존 id 또는 null",
  "name": "사업 이름 (연도·회차 빼고 짧게)",
  "category": "교육일자리|주거복지|참여권리|문화예술",
  "benefit": "혜택 한 줄 (금액·내용)",
  "apply": {{"start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null", "periodText": "원문의 신청기간 표현"}},
  "age": {{"min": 숫자|null, "max": 숫자|null}},
  "residence": {{"type": "R1|R2|R4|R6|R7|R8|R10|R9", "text": "원문의 거주 조건"}},
  "otherConditions": ["소득·취업·학적 등 판정하지 않는 조건"],
  "evidence": "자격 조건이 적힌 원문 문장 그대로",
  "reason": "판단 이유 한 줄"
}}
거주 유형: R1 안산 주민등록 / R2 안산 거주기간(연속·합산 N년) / R4 안산 주민등록+경기도 거주기간 /
R6 안산 주민등록 또는 안산 소재 학교·직장·사업장 / R7 거주 무관 / R8 경기도 거주 / R10 안산 외 거주자만 / R9 모르겠음"""
