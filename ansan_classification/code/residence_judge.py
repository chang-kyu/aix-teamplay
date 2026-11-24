"""
거주 요건 판정 함수 (데모용)  —  ansan_residence_requirements.csv 를 읽어서 사용자별로 판정
결과: 충족 / 미충족 / 확인필요  +  이유  +  "어떻게 하면 충족되는지"(what-if)
※ 거주 요건만 본다. 나이·소득·취업 조건은 별도 필터에서 판정.
"""
from datetime import date, timedelta
import pandas as pd


def years_between(d1, d2):
    return (d2 - d1).days / 365.25


def judge(row, u, today):
    t = row["residence_type"]
    reg = u.get("ansan_move_in")                       # 안산 전입일(주민등록). 없으면 None
    cont = years_between(reg, today) if reg else 0.0    # 안산 연속 거주 연수
    cum = cont + u.get("ansan_prior_years", 0)          # 안산 합산 거주 연수
    alts = [a for a in str(row["alt_life_zone"]).split(";") if a and a != "nan"]

    if t == "R7":
        return "충족", "거주 조건 없음", ""
    if t == "R10":   # 안산 외 거주자만 (예: 안산에서 살아보기)
        return ("미충족", "안산 주민등록자는 신청 불가(타 시군 거주자 대상)", "") if reg else ("충족", "안산 외 거주", "")
    if t == "R8":
        ok = u.get("gyeonggi_resident", bool(reg))
        return ("충족", "경기도 거주", "") if ok else ("미충족", "경기도 거주 아님", "경기도로 전입하면 충족")
    if t == "R9":
        return ("충족", "안산 주민등록", "") if reg else ("확인필요", "안산 시민·청년 대상(주민등록 필요 여부 불명확)", "기관에 문의")
    if t == "R1":
        return ("충족", "안산 주민등록 있음", "") if reg else ("미충족", "안산 주민등록 없음", "전입신고하면 충족")
    if t == "R6":
        if reg:
            return "충족", "안산 주민등록 있음", ""
        hit = [a for a in alts if u.get({"학교": "school_in_ansan", "직장": "work_in_ansan",
                                         "사업장": "business_in_ansan", "활동": "active_in_ansan"}[a])]
        if hit:
            return "충족", f"주민등록 없어도 생활권({', '.join(hit)})으로 인정", ""
        return "미충족", "안산 주민등록·생활권 없음", "전입신고하면 충족"
    if t == "R5":
        lo, hi = date.fromisoformat(row["move_in_from"]), date.fromisoformat(row["move_in_to"])
        if reg and lo <= reg <= hi:
            return "충족", f"전입일 {reg}가 인정기간 안", ""
        return "미충족", f"전입(이사)일이 {lo}~{hi} 밖", "다음 연도 공고의 인정기간 확인"
    if t in ("R2", "R3", "R4"):
        if t == "R4":
            if not reg:
                return "미충족", "안산 주민등록 없음", "전입신고 + 경기도 거주기간 충족 필요"
            g_cont = years_between(u["gyeonggi_since"], today) if u.get("gyeonggi_since") else cont
            g_cum = g_cont + u.get("gyeonggi_prior_years", 0)
            ok, c, s, region = g_cont >= row["min_continuous_years"] or g_cum >= row["min_cumulative_years"], g_cont, u.get("gyeonggi_since") or reg, "경기도"
        else:
            ok, c, s, region = reg is not None and (cont >= row["min_continuous_years"] or cum >= row["min_cumulative_years"]), cont, reg, "안산"
        if not ok:
            if s is None:
                return "미충족", "안산 주민등록 없음", f"전입신고 후 {row['min_continuous_years']}년 거주하면 충족"
            when = s + timedelta(days=round(365.25 * row["min_continuous_years"]))
            return "미충족", f"{region} 연속 {c:.1f}년 (필요 {row['min_continuous_years']}년)", f"{when}부터 충족(그때 공고 기준)"
        if t == "R3" and not (u.get("family_in_ansan") or u.get("no_family")):
            return "미충족", "거주기간은 충족, 가족 안산 거주 조건 미충족", "가족 1인 이상 안산 거주 필요"
        return "충족", f"{region} 연속 {c:.1f}년", ""
    return "확인필요", "유형 미분류", ""


def run(user, today=None, path="ansan_residence_requirements.csv"):
    today = today or date.today()
    df = pd.read_csv(path)
    out = df.apply(lambda r: pd.Series(judge(r, user, today), index=["result", "reason", "what_if"]), axis=1)
    cols = ["policy_id", "policy_name", "residence_type"] + (["residence_bonus"] if "residence_bonus" in df else [])
    return pd.concat([df[cols], out], axis=1)


if __name__ == "__main__":
    # 주 페르소나 김도현: 제천 출신, ERICA 3학년, 안산 전입 1년 8개월
    dohyun = {"ansan_move_in": date(2025, 2, 2), "ansan_prior_years": 0,
              "school_in_ansan": True, "family_in_ansan": False}
    # 전입신고를 안 한 같은 학생
    no_reg = {"ansan_move_in": None, "school_in_ansan": True}
    for label, u in [("도현(전입 1년8개월)", dohyun), ("전입신고 안 한 ERICA생", no_reg)]:
        r = run(u, today=date(2026, 10, 2))
        print(f"\n=== {label} ===")
        print(r.result.value_counts().to_string())
        print(r[r.result != "충족"][["policy_name", "residence_type", "reason", "what_if"]].to_string(index=False))
