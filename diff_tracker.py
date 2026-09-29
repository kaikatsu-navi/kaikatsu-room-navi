import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import config

logger = logging.getLogger(__name__)


def save_snapshot(data: List[Dict[str, Any]]) -> Path:
    """
    最新の取得データをJSONスナップショットとして保存する。
    """
    config.HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot_path = config.HISTORY_DIR / f"snapshot_{timestamp}.json"
    latest_path = config.HISTORY_DIR / "latest.json"

    # 新しいスナップショットを書き込み
    with open(snapshot_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    logger.info(f"スナップショットを保存しました: {snapshot_path}")
    return snapshot_path


def get_latest_snapshot() -> Tuple[Optional[Path], List[Dict[str, Any]]]:
    """
    直前のスナップショットファイルとデータを取得する。
    """
    if not config.HISTORY_DIR.exists():
        return None, []

    files = sorted(config.HISTORY_DIR.glob("snapshot_*.json"))
    if not files:
        return None, []

    latest_file = files[-1]
    try:
        with open(latest_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return latest_file, data
    except Exception as e:
        logger.warning(f"直前スナップショットの読み込みに失敗: {e}")
        return None, []


def compare_snapshots(
    current_data: List[Dict[str, Any]],
    previous_data: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    現在データと前回データを比較し、料金変更のあった店舗・項目・新旧価格を抽出する。
    """
    if not previous_data:
        return []

    # 店舗コードをキーにした辞書化
    prev_map = {item["店舗コード"]: item for item in previous_data}
    diffs = []
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 監視対象の料金項目
    target_fields = [
        "平日_基本30分", "平日_延長10分",
        "平日_3hパック", "平日_6hパック", "平日_9hパック", "平日_12hパック",
        "平日_15hパック", "平日_18hパック", "平日_21hパック", "平日_24hパック",
        "平日_ナイト8h",
        "週末_基本30分", "週末_延長10分",
        "週末_3hパック", "週末_6hパック", "週末_9hパック", "週末_12hパック",
        "週末_15hパック", "週末_18hパック", "週末_21hパック", "週末_24hパック",
        "週末_ナイト8h",
        "週末料金注記"
    ]

    for curr in current_data:
        code = curr.get("店舗コード")
        if not code or code not in prev_map:
            # 新規追加店舗
            continue

        prev = prev_map[code]
        for field in target_fields:
            old_val = prev.get(field)
            new_val = curr.get(field)

            # 変更がある場合
            if old_val != new_val:
                diff_amount = None
                if isinstance(old_val, (int, float)) and isinstance(new_val, (int, float)):
                    diff_amount = new_val - old_val

                diffs.append({
                    "検知日時": now_str,
                    "店舗コード": code,
                    "都道府県": curr.get("都道府県", ""),
                    "市区町村": curr.get("市区町村", ""),
                    "店舗名": curr.get("店舗名", ""),
                    "変更項目": field,
                    "改定前": old_val if old_val is not None else "-",
                    "改定後": new_val if new_val is not None else "-",
                    "差額": f"{diff_amount:+d}円" if diff_amount is not None else "変更",
                })

    return diffs
