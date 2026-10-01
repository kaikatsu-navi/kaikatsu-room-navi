import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("validator")

# 時間順のパックキーリスト
PACK_KEYS_WEEKDAY = [
    ("3h", "平日_3hパック"),
    ("6h", "平日_6hパック"),
    ("9h", "平日_9hパック"),
    ("12h", "平日_12hパック"),
    ("15h", "平日_15hパック"),
    ("18h", "平日_18hパック"),
    ("21h", "平日_21hパック"),
    ("24h", "平日_24hパック"),
]

PACK_KEYS_WEEKEND = [
    ("3h", "週末_3hパック"),
    ("6h", "週末_6hパック"),
    ("9h", "週末_9hパック"),
    ("12h", "週末_12hパック"),
    ("15h", "週末_15hパック"),
    ("18h", "週末_18hパック"),
    ("21h", "週末_21hパック"),
    ("24h", "週末_24hパック"),
]

ALL_PRICE_KEYS = [
    "平日_基本30分", "平日_延長10分", "平日_3hパック", "平日_6hパック",
    "平日_9hパック", "平日_12hパック", "平日_15hパック", "平日_18hパック",
    "平日_21hパック", "平日_24hパック", "平日_ナイト8h", "平日_ナイト12h",
    "週末_基本30分", "週末_延長10分", "週末_3hパック", "週末_6hパック",
    "週末_9hパック", "週末_12hパック", "週末_15hパック", "週末_18hパック",
    "週末_21hパック", "週末_24hパック", "週末_ナイト8h", "週末_ナイト12h"
]


def _to_int(val: Any) -> Optional[int]:
    if val in [None, "", "-"]:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def validate_store_row(
    current_row: Dict[str, Any],
    prev_row: Optional[Dict[str, Any]] = None
) -> Tuple[Dict[str, Any], List[str]]:
    """
    1店舗分の行データを論理検証し、異常があれば前回の値でフォールバック（自己防衛）する。
    戻り値: (修復済み行データ, 検知された警告メッセージリスト)
    """
    row = dict(current_row)
    warnings = []
    store_code = str(row.get("店舗コード", ""))
    store_name = f"[{store_code}] {row.get('都道府県', '')} {row.get('店舗名', '')}"

    prev = prev_row or {}

    # 1. 基本料金の範囲チェック (100円 ~ 1,500円)
    w_basic = _to_int(row.get("平日_基本30分"))
    if w_basic is None or not (100 <= w_basic <= 1500):
        prev_basic = _to_int(prev.get("平日_基本30分"))
        if prev_basic:
            warnings.append(f"{store_name}: 平日基本30分が異常値 ({w_basic}) のため前回の値 ({prev_basic}) に修復")
            row["平日_基本30分"] = prev_basic

    # 2. 時間パックの単調非減少チェック（平日）
    last_val = 0
    for label, key in PACK_KEYS_WEEKDAY:
        v = _to_int(row.get(key))
        if v is not None:
            if v < last_val:
                # 逆転検知！
                prev_v = _to_int(prev.get(key))
                if prev_v and prev_v >= last_val:
                    warnings.append(f"{store_name}: {label}平日パック({v}円)が前パック({last_val}円)より安いため、前回の値({prev_v}円)に修復")
                    row[key] = prev_v
                    last_val = prev_v
                else:
                    warnings.append(f"{store_name}: {label}平日パック({v}円)が前パック({last_val}円)より安いため、直前パックと同額({last_val}円)に補正")
                    row[key] = last_val
            else:
                last_val = v

    # 3. 時間パックの単調非減少チェック（週末）
    last_val_wend = 0
    for label, key in PACK_KEYS_WEEKEND:
        v = _to_int(row.get(key))
        if v is not None:
            if v < last_val_wend:
                prev_v = _to_int(prev.get(key))
                if prev_v and prev_v >= last_val_wend:
                    warnings.append(f"{store_name}: {label}週末パック({v}円)が前パック({last_val_wend}円)より安いため、前回の値({prev_v}円)に修復")
                    row[key] = prev_v
                    last_val_wend = prev_v
                else:
                    warnings.append(f"{store_name}: {label}週末パック({v}円)が前パック({last_val_wend}円)より安いため、直前パックと同額({last_val_wend}円)に補正")
                    row[key] = last_val_wend
            else:
                last_val_wend = v

    # 4. 週末 >= 平日 チェック
    for wday_k in ["平日_基本30分", "平日_延長10分", "平日_3hパック", "平日_6hパック", "平日_9hパック", "平日_12hパック", "平日_18hパック", "平日_24hパック"]:
        wend_k = wday_k.replace("平日", "週末")
        w_val = _to_int(row.get(wday_k))
        e_val = _to_int(row.get(wend_k))
        if w_val is not None and e_val is not None and e_val < w_val:
            prev_e = _to_int(prev.get(wend_k))
            if prev_e and prev_e >= w_val:
                warnings.append(f"{store_name}: {wend_k}({e_val}円)が{wday_k}({w_val}円)より安いため前回の値({prev_e}円)に修復")
                row[wend_k] = prev_e
            else:
                warnings.append(f"{store_name}: {wend_k}({e_val}円)が{wday_k}({w_val}円)より安いため平日と同額({w_val}円)に補正")
                row[wend_k] = w_val

    # 5. 極端な急変（スパイク）ガード (0.4倍以下、または2.5倍以上)
    if prev:
        for k in ALL_PRICE_KEYS:
            cur_v = _to_int(row.get(k))
            prev_v = _to_int(prev.get(k))
            if cur_v is not None and prev_v is not None and prev_v > 0:
                ratio = cur_v / prev_v
                if ratio < 0.4 or ratio > 2.5:
                    warnings.append(f"{store_name}: {k}に異常急変({prev_v}円 → {cur_v}円, {ratio:.1f}倍)を検知したため前回の値に復元")
                    row[k] = prev_v

    return row, warnings


def validate_and_sanitize(
    current_data: List[Dict[str, Any]],
    prev_store_map: Optional[Dict[str, Dict[str, Any]]] = None
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    全店舗データを一括検証し、異常値を自己修復して安全なデータを返す。
    """
    prev_map = prev_store_map or {}
    sanitized_data = []
    all_warnings = []

    for cur in current_data:
        code = str(cur.get("店舗コード", ""))
        prev = prev_map.get(code)
        clean_row, warns = validate_store_row(cur, prev)
        sanitized_data.append(clean_row)
        all_warnings.extend(warns)

    if all_warnings:
        logger.warning(f"【自己防衛バリデーション作動】 合計 {len(all_warnings)} 件の異常値を自動修復しました：")
        for w in all_warnings:
            logger.warning(f"  🛡️ {w}")
    else:
        logger.info("【自己防衛バリデーション合格】 全店舗の料金データが論理的整合性ルールを満たしています！")

    return sanitized_data, all_warnings
