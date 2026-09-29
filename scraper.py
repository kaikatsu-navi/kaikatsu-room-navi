import json
import logging
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Dict, List, Optional

import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


def fetch_key_room_stores() -> List[Dict[str, Any]]:
    """
    快活CLUBの全店舗JS(shop.js)から「鍵付完全個室」が設置されている店舗一覧を抽出する。
    """
    logger.info("店舗マスタ(shop.js)を取得中...")
    req = urllib.request.Request(
        config.SHOP_JS_URL,
        headers={"User-Agent": config.USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=config.REQUEST_TIMEOUT) as resp:
        text = resp.read().decode("utf-8")

    # var stores = { ... }; の部分をJSONとして抽出
    match = re.search(r"var\s+stores\s*=\s*(\{.*?\});\s*(?:var|$)", text, re.DOTALL)
    if not match:
        raise ValueError("shop.js から var stores の抽出に失敗しました。")

    stores_data = json.loads(match.group(1))

    key_stores = []
    for pref, store_list in stores_data.items():
        for s in store_list:
            services = s.get("service", [])
            if "鍵付完全個室" in services:
                s_copy = dict(s)
                s_copy["pref"] = pref
                key_stores.append(s_copy)

    logger.info(f"鍵付完全個室が設置されている店舗数: {len(key_stores)} 店")
    return key_stores


def _parse_store_price_record(records: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    店舗の料金レコードリストから現在日時に有効な料金オブジェクトを判定して返す。
    公式サイトの shop_detail.js と同等のロジック。
    """
    if not records:
        return None

    def _parse_dt(d_str: Any, t_str: Any, is_end: bool = False) -> Optional[datetime]:
        if not d_str:
            return None
        d_clean = re.sub(r"\D", "", str(d_str))
        t_clean = re.sub(r"\D", "", str(t_str or ""))
        if len(d_clean) < 8:
            return None
        year = int(d_clean[0:4])
        month = int(d_clean[4:6])
        day = int(d_clean[6:8])
        hour = 0
        minute = 0
        second = 0
        if len(t_clean) >= 4:
            hour = int(t_clean[0:2])
            minute = int(t_clean[2:4])
            if len(t_clean) >= 6:
                second = int(t_clean[4:6])
        elif is_end:
            hour = 23
            minute = 59
            second = 59
        try:
            return datetime(year, month, day, hour, minute, second)
        except Exception:
            return None

    now = datetime.now()
    default_record = None
    matched_record = None

    for r in records:
        start_date = str(r.get("start_date", "")).strip()
        if not start_date:
            default_record = r
            continue

        start_dt = _parse_dt(start_date, r.get("start_time"))
        end_dt = _parse_dt(r.get("end_date"), r.get("end_time"), is_end=True)

        if start_dt and end_dt:
            if start_dt <= now <= end_dt:
                matched_record = r
                break
        elif start_dt and not end_dt:
            if start_dt <= now:
                matched_record = r
                break

    # 公式JS: 有効期間一致 -> start_date無しのレコード -> 最初のレコード(records[0])
    if matched_record is not None:
        return matched_record
    if default_record is not None:
        return default_record
    return records[0]



import ocr_reader


def fetch_store_price(store_code: str) -> Optional[Dict[str, Any]]:
    """
    単一店舗の料金データを取得する。
    1. 公式JSON (/public/{store_code}.json) を取得
    2. JSONが存在しない、または空の場合は店舗ページの料金画像からOCR抽出 (Cloud Vision API)
    """
    url = config.PRICE_JSON_URL_TEMPLATE.format(store_code=store_code)
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
    price_data = None
    try:
        with urllib.request.urlopen(req, timeout=config.REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list) and len(data) > 0:
                price_data = _parse_store_price_record(data)
            elif isinstance(data, dict):
                price_data = data
    except Exception as e:
        logger.debug(f"店舗 [{store_code}] のJSON取得失敗: {e}")

    # JSONから料金が取得できなかった場合、料金表画像からOCR抽出
    if not price_data or not price_data.get("private_weekday_basic_taxfee"):
        try:
            ocr_data = ocr_reader.get_store_price_from_image(store_code)
            if ocr_data:
                if price_data:
                    price_data.update(ocr_data)
                else:
                    price_data = ocr_data
        except Exception as e:
            logger.warning(f"店舗 [{store_code}] の画像OCR抽出失敗: {e}")

    return price_data


def extract_price_row(store_info: Dict[str, Any], price_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    店舗情報と料金JSONから、一覧・スプシ用のフラットな行データを生成する。
    """
    p = price_data or {}

    def get_num(key: str) -> Any:
        val = p.get(key, "")
        if val == "-":
            return "-"
        if val is None or val == "":
            # 20949（渋谷）や20959（銀座）など都心型で特定時間パックが存在しない場合
            code = str(store_info.get("store_code", ""))
            if code in ["20949", "20959"]:
                return "-"
            return None
        try:
            return int(val)
        except (ValueError, TypeError):
            return str(val)


    # 設備・サービス判定用セット
    services = set(store_info.get("service", []))
    roomtypes = set(store_info.get("roomtype", []))
    karaokes = set(store_info.get("karaoke", []))
    darts = set(store_info.get("darts", []))
    billiards = set(store_info.get("billiards", []))

    # 個室の設備タイプ（roomtype から鍵付完全個室関連を抽出）
    roomtypes_summary = [t for t in store_info.get("roomtype", []) if any(k in t for k in ["ルーム", "個室", "フラット", "多機能"])]
    roomtype_str = ", ".join(roomtypes_summary) if roomtypes_summary else ", ".join(store_info.get("roomtype", []))

    address = re.sub(r"<br\s*/?>", " ", store_info.get("address", "")).strip()

    row = {
        # 1. 基本情報
        "店舗コード": str(store_info.get("store_code", "")),
        "都道府県": store_info.get("pref", ""),
        "市区町村": store_info.get("cf_store_city", ""),
        "店舗名": store_info.get("store_name", ""),
        "電話番号": store_info.get("tel", ""),
        "住所": address,
        "個室タイプ": roomtype_str,
        "週末料金注記": p.get("annotation_weekend_1", "") or "",

        # 2. 平日料金
        "平日_基本30分": get_num("private_weekday_basic_taxfee"),
        "平日_延長10分": get_num("private_weekday_10_taxfee"),
        "平日_3hパック": get_num("private_weekday_3h_taxfee"),
        "平日_6hパック": get_num("private_weekday_6h_taxfee"),
        "平日_9hパック": get_num("private_weekday_9h_taxfee"),
        "平日_12hパック": get_num("private_weekday_12h_taxfee"),
        "平日_15hパック": get_num("private_weekday_15h_taxfee"),
        "平日_18hパック": get_num("private_weekday_18h_taxfee"),
        "平日_21hパック": get_num("private_weekday_21h_taxfee"),
        "平日_24hパック": get_num("private_weekday_24h_taxfee"),
        "平日_ナイト8h": get_num("private_weekday_night8_taxfee"),

        # 3. 週末料金
        "週末_基本30分": get_num("private_weekend_basic_taxfee"),
        "週末_延長10分": get_num("private_weekend_10_taxfee"),
        "週末_3hパック": get_num("private_weekend_3h_taxfee"),
        "週末_6hパック": get_num("private_weekend_6h_taxfee"),
        "週末_9hパック": get_num("private_weekend_9h_taxfee"),
        "週末_12hパック": get_num("private_weekend_12h_taxfee"),
        "週末_15hパック": get_num("private_weekend_15h_taxfee"),
        "週末_18hパック": get_num("private_weekend_18h_taxfee"),
        "週末_21hパック": get_num("private_weekend_21h_taxfee"),
        "週末_24hパック": get_num("private_weekend_24h_taxfee"),
        "週末_ナイト8h": get_num("private_weekend_night8_taxfee"),

        # 4. 設備・サービス（オレンジアイコン）
        "個室WEB予約": "鍵付完全個室 WEB予約" in services,
        "無料シャワー": "シャワー（無料）" in services,
        "有料シャワー": "シャワー（有料）" in services,
        "コインランドリー": "コインランドリー（有料）" in services,
        "駐車場": "駐車場" in services,
        "飲み放題カフェ": "飲み放題カフェ" in services,
        "100円モーニング": "100円モーニング" in services,
        "無料トースト": "無料トースト" in services,
        "ソフトクリーム": "ソフトクリーム" in services,
        "アルコール販売": "アルコール販売" in services,
        "タオル使い放題": "タオル使い放題" in services,
        "加熱式たばこエリア": "加熱式たばこ専用エリア" in services,

        # 5. 席・部屋タイプ（グリーンアイコン）
        "個室_多機能": "レギュラールーム（多機能）" in roomtypes,
        "個室_フラット": "レギュラールーム（フラット）" in roomtypes,
        "ワイドルーム": "ワイドルーム" in roomtypes,
        "VIPフラット": "VIPフラットルーム" in roomtypes,
        "リクライニング": "リクライニングシート" in roomtypes,
        "フルフラット": "フルフラットシート" in roomtypes,
        "マッサージ": "マッサージシート" in roomtypes,

        # 6. アミューズメント（ブルーアイコン）
        "カラオケ": len(karaokes) > 0,
        "ダーツ": len(darts) > 0,
        "ビリヤード": len(billiards) > 0,
    }
    return row


def fetch_all_key_rooms_data() -> List[Dict[str, Any]]:
    """
    全店舗の完全個室料金データを一括取得してリストで返す。
    """
    stores = fetch_key_room_stores()
    total = len(stores)
    results: List[Dict[str, Any]] = []

    logger.info(f"全 {total} 店舗の料金データを並行取得中（並行数: {config.MAX_WORKERS}）...")

    with ThreadPoolExecutor(max_workers=config.MAX_WORKERS) as pool:
        future_to_store = {
            pool.submit(fetch_store_price, s["store_code"]): s
            for s in stores
        }
        completed = 0
        for future in as_completed(future_to_store):
            s = future_to_store[future]
            price_data = future.result()
            row = extract_price_row(s, price_data)
            results.append(row)
            completed += 1
            if completed % 50 == 0 or completed == total:
                logger.info(f"進捗: {completed}/{total} 店舗完了 ({completed * 100 // total}%)")

    # 店舗コード順にソート
    results.sort(key=lambda x: int(x["店舗コード"]) if x["店舗コード"].isdigit() else 999999)
    return results


if __name__ == "__main__":
    data = fetch_all_key_rooms_data()
    print(f"取得完了: {len(data)} 件")
    if data:
        print("サンプル1件目:")
        print(json.dumps(data[0], indent=2, ensure_ascii=False))
