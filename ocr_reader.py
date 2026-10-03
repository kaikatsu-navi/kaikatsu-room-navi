import base64
import json
import logging
import re
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup
import google.auth.transport.requests
from google.oauth2.service_account import Credentials

import config

logger = logging.getLogger(__name__)

# トークンのキャッシュ
_cached_token = None


def get_auth_token() -> Optional[str]:
    """
    Cloud Vision API用のOAuth2アクセストークンを取得する。
    """
    global _cached_token
    try:
        creds = Credentials.from_service_account_file(
            config.CREDENTIALS_FILE,
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        request = google.auth.transport.requests.Request()
        creds.refresh(request)
        _cached_token = creds.token
        return _cached_token
    except Exception as e:
        logger.warning(f"Google Cloud 認証トークンの取得に失敗: {e}")
        return None


def fetch_price_image_url(store_code: str) -> Optional[str]:
    """
    店舗詳細ページのHTMLから料金表画像のURLを抽出する。
    """
    page_url = f"https://www.kaikatsu.jp/shop/detail/{store_code}.html"
    try:
        req = urllib.request.Request(page_url, headers={"User-Agent": config.USER_AGENT})
        with urllib.request.urlopen(req, timeout=config.REQUEST_TIMEOUT) as resp:
            html = resp.read().decode("utf-8")

        soup = BeautifulSoup(html, "html.parser")
        price_area = soup.find("div", class_="shop-price-area")
        if not price_area:
            return None

        imgs = price_area.find_all("img")
        # 会員制の共通バナー (7393246948) 以外の料金表画像を探す
        real_imgs = [img.get("src") for img in imgs if img.get("src") and "7393246948" not in img.get("src")]
        if real_imgs:
            return urllib.parse.urljoin(page_url, real_imgs[0])
        elif imgs and imgs[0].get("src"):
            return urllib.parse.urljoin(page_url, imgs[0]["src"])
    except Exception as e:
        logger.warning(f"店舗 [{store_code}] のHTMLからの画像URL抽出失敗: {e}")
    return None


def ocr_image_url(img_url: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Cloud Vision API (DOCUMENT_TEXT_DETECTION) を使用して画像から詳細アノテーションとテキストを抽出する。
    """
    token = get_auth_token()
    if not token:
        return None, None

    try:
        req_img = urllib.request.Request(img_url, headers={"User-Agent": config.USER_AGENT})
        with urllib.request.urlopen(req_img, timeout=config.REQUEST_TIMEOUT) as resp:
            img_bytes = resp.read()

        b64 = base64.b64encode(img_bytes).decode("utf-8")
        api_url = "https://vision.googleapis.com/v1/images:annotate"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8"
        }
        payload = {
            "requests": [
                {
                    "image": {"content": b64},
                    "features": [{"type": "DOCUMENT_TEXT_DETECTION"}]
                }
            ]
        }
        req_api = urllib.request.Request(
            api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers
        )
        with urllib.request.urlopen(req_api, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        responses = data.get("responses", [])
        if responses and "fullTextAnnotation" in responses[0]:
            full_ann = responses[0]["fullTextAnnotation"]
            return full_ann, full_ann.get("text", "")
    except Exception as e:
        logger.warning(f"Cloud Vision API 呼び出し失敗 ({img_url}): {e}")
    return None, None



def parse_prices_from_ocr(text: str) -> Dict[str, Any]:
    """
    OCRテキストから完全個室の料金項目を抽出する。
    """
    result = {}
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 週末料金注記の抽出
    weekend_note = ""
    for l in lines:
        if any(k in l for k in ["土日・祝日", "休日料金", "加算されます", "休日料"]):
            weekend_note = l
            break
    result["annotation_weekend_1"] = weekend_note

    add_fee = 0
    if weekend_note:
        m_add = re.search(r"(\d{2,3})円が加算", weekend_note)
        if m_add:
            add_fee = int(m_add.group(1))

    # モード判定:
    # 最初の20行以内に「平日」と「休日/土日」が単独の行として存在するか判定
    has_weekday_weekend = (
        any(l in ["平日", "平日料金"] for l in lines[:20]) and
        any(l in ["休日", "土日", "休日料金"] for l in lines[:20])
    )

    def extract_yen(s):
        s_clean = s.replace(",", "").replace(" ", "")
        m = re.findall(r"(\d{3,5})円?", s_clean)
        return [int(x) for x in m if 50 <= int(x) <= 20000]

    # 時間スロットの正規表現パターン（長い順に並べて数字の誤爆を防ぐ）
    patterns = [
        (r"(?:基本|最初の)30分|30分", "private_weekday_basic_taxfee", "private_weekend_basic_taxfee"),
        (r"以降10分|10分ごと|10分", "private_weekday_10_taxfee", "private_weekend_10_taxfee"),
        (r"(?:^|[^0-9])24時間", "private_weekday_24h_taxfee", "private_weekend_24h_taxfee"),
        (r"(?:^|[^0-9])21時間", "private_weekday_21h_taxfee", "private_weekend_21h_taxfee"),
        (r"(?:^|[^0-9])18時間", "private_weekday_18h_taxfee", "private_weekend_18h_taxfee"),
        (r"(?:^|[^0-9])15時間", "private_weekday_15h_taxfee", "private_weekend_15h_taxfee"),
        (r"(?:^|[^0-9])12時間", "private_weekday_12h_taxfee", "private_weekend_12h_taxfee"),
        (r"(?:^|[^0-9])9時間", "private_weekday_9h_taxfee", "private_weekend_9h_taxfee"),
        (r"(?:^|[^0-9])6時間", "private_weekday_6h_taxfee", "private_weekend_6h_taxfee"),
        (r"(?:^|[^0-9])3時間", "private_weekday_3h_taxfee", "private_weekend_3h_taxfee"),
        (r"(?:^|[^0-9])2時間", "private_weekday_2h_taxfee", "private_weekend_2h_taxfee"),
        (r"(?:^|[^0-9])1時間", "private_weekday_1h_taxfee", "private_weekend_1h_taxfee"),
        (r"ナイト(?:12|8)?時間|ナイトパック", "private_weekday_night8_taxfee", "private_weekend_night8_taxfee"),
    ]

    assigned_slots = set()
    i = 0
    while i < len(lines):
        line = lines[i]
        matched = None
        for pat, weekday_key, weekend_key in patterns:
            if weekday_key not in assigned_slots and re.search(pat, line):
                matched = (weekday_key, weekend_key)
                break

        if matched:
            weekday_key, weekend_key = matched
            assigned_slots.add(weekday_key)
            found_prices = []
            j = i + 1
            while j < len(lines) and len(found_prices) < 4:
                if any(re.search(pat, lines[j]) for pat, _, _ in patterns):
                    break
                prices = extract_yen(lines[j])
                found_prices.extend(prices)
                j += 1

            if found_prices:
                if has_weekday_weekend:
                    # [平日, 休日] 2列
                    weekday_val = found_prices[0]
                    weekend_val = found_prices[1] if len(found_prices) > 1 else (weekday_val + add_fee if add_fee else None)
                else:
                    # [カフェ, ブース, 鍵付完全個室] など -> 最後の値が個室
                    weekday_val = found_prices[-1]
                    weekend_val = weekday_val + add_fee if add_fee else weekday_val

                result[weekday_key] = weekday_val
                if weekend_val:
                    result[weekend_key] = weekend_val

            i = j - 1
        i += 1

    return result


def parse_prices_geometric(full_text_annotation: Dict[str, Any], text_fallback: str) -> Dict[str, Any]:
    """
    Cloud Vision API の Word レベル座標を使って快活CLUBの料金表画像を幾何学的に解析する。
    - VIPルーム / 鍵付完全個室 / シャワー・トイレ付き の自動判定
    - 1列のみ店舗（完全個室専門店）の自動判定
    - 平日・休日サブ列（大阪十三、渋谷、銀座など）の自動判定
    - セル結合（複数時間帯にまたがる料金）の自動伝播
    - 最下部延長10分ボックスの自動マッピング
    """
    result = {}

    # 1. 週末料金注記
    lines = [l.strip() for l in text_fallback.splitlines() if l.strip()]
    weekend_note = ""
    for l in lines:
        if any(k in l for k in ["土日・祝日", "休日料金", "加算されます", "休日料", "下記料金表とは異なります", "休日料金となります"]):
            weekend_note = l
            break
    result["annotation_weekend_1"] = weekend_note

    add_fee = 0
    pack_only_add = False
    if weekend_note:
        m_add = re.search(r"(\d{2,3})円が加算", weekend_note)
        if m_add:
            add_fee = int(m_add.group(1))
        if "パック料金に" in weekend_note:
            pack_only_add = True

    pages = full_text_annotation.get("pages", [])
    if not pages:
        return result
    page = pages[0]

    # 全単語（words）の抽出
    all_words = []
    for b in page.get("blocks", []):
        for p in b.get("paragraphs", []):
            for w in p.get("words", []):
                w_str = "".join([s.get("text", "") for s in w.get("symbols", [])])
                v = w.get("boundingBox", {}).get("vertices", [])
                if not v:
                    continue
                xs = [pt.get("x", 0) for pt in v]
                ys = [pt.get("y", 0) for pt in v]
                all_words.append({
                    "text": w_str,
                    "min_x": min(xs), "max_x": max(xs),
                    "min_y": min(ys), "max_y": max(ys),
                    "center_x": (min(xs) + max(xs)) / 2,
                    "center_y": (min(ys) + max(ys)) / 2,
                })

    # 2. 列構造の分析 (ヘッダー y < 480)
    # A. VIPルーム
    vip_words = [w for w in all_words if w["center_y"] < 480 and "VIP" in w["text"].upper()]
    # B. 鍵付完全個室
    koshitsu_words = [w for w in all_words if w["center_y"] < 480 and ("完全個室" in w["text"] or "個室" in w["text"])]
    # C. シャワー / トイレ
    shower_toilet_words = [w for w in all_words if w["center_y"] < 480 and any(k in w["text"] for k in ["シャワー", "トイレ"])]

    # 20901 新横浜対策: 「シャワー・トイレ付」の個室と、通常の個室を区別
    pure_koshitsu_words = []
    for kw in koshitsu_words:
        is_shower = any(abs(kw["center_x"] - st["center_x"]) < 70 and abs(kw["center_y"] - st["center_y"]) < 60 for st in shower_toilet_words)
        if not is_shower:
            pure_koshitsu_words.append(kw)

    # ターゲット列の決定
    has_sub_weekday_weekend = False
    target_weekday_x = None
    target_weekend_x = None

    if vip_words:
        target_x = vip_words[0]["center_x"]
        target_col_name = "VIPルーム"
    elif pure_koshitsu_words:
        target_x = pure_koshitsu_words[0]["center_x"]
        target_col_name = "鍵付完全個室(通常)"
    elif koshitsu_words:
        target_x = koshitsu_words[0]["center_x"]
        target_col_name = "鍵付完全個室"
    else:
        target_x = 750.0
        target_col_name = "デフォルト(中央~右)"

    # ヘッダー下に「平日」「休日」のサブ列があるかチェック (例: 20985十三、20949渋谷、20959銀座)
    sub_headers = []
    for i, w in enumerate(all_words):
        if 250 < w["center_y"] < 490:
            if w["text"] in ["平日", "休日", "土日"]:
                sub_headers.append(w)
            elif w["text"] == "休" and i + 1 < len(all_words) and all_words[i+1]["text"] == "日":
                combined = {
                    "text": "休日",
                    "center_x": (w["center_x"] + all_words[i+1]["center_x"]) / 2,
                    "center_y": (w["center_y"] + all_words[i+1]["center_y"]) / 2,
                }
                sub_headers.append(combined)

    nearby_sub = [w for w in sub_headers if abs(w["center_x"] - target_x) < 260]
    weekday_subs = [w for w in nearby_sub if w["text"] == "平日"]
    weekend_subs = [w for w in nearby_sub if w["text"] in ["休日", "土日"]]

    if weekday_subs and weekend_subs:
        has_sub_weekday_weekend = True
        w_x = weekday_subs[0]["center_x"]
        e_x = weekend_subs[0]["center_x"]
        target_weekday_x = min(w_x, e_x)
        target_weekend_x = max(w_x, e_x)
        logger.debug(f"Detected sub columns: 平日 x={target_weekday_x:.1f}, 休日 x={target_weekend_x:.1f}")

    # 3. 1列のみ店舗（完全個室専門店）の判定
    other_headers = [w for w in all_words if w["center_y"] < 480 and any(k in w["text"] for k in ["カフェ", "ブース", "ダーツ", "カラオケ"])]
    is_single_column_store = (len(other_headers) == 0 and not has_sub_weekday_weekend)

    # 4. 時間プラン行 (左端) の特定
    time_defs = [
        ("private_weekday_basic_taxfee", "private_weekend_basic_taxfee", r"(?:基本|最初|30分)", False, False),
        ("private_weekday_10_taxfee", "private_weekend_10_taxfee", r"(?:以降|10分|延長)", False, False),
        ("private_weekday_1h_taxfee", "private_weekend_1h_taxfee", r"(?:^|[^0-9])1(?:時間|h)?$", True, False),
        ("private_weekday_3h_taxfee", "private_weekend_3h_taxfee", r"(?:^|[^0-9])3(?:時間|h)?", True, False),
        ("private_weekday_6h_taxfee", "private_weekend_6h_taxfee", r"(?:^|[^0-9])6(?:時間|h)?", True, False),
        ("private_weekday_9h_taxfee", "private_weekend_9h_taxfee", r"(?:^|[^0-9])9(?:時間|h)?", True, False),
        ("private_weekday_12h_taxfee", "private_weekend_12h_taxfee", r"(?:^|[^0-9])12(?:時間|h)?", True, False),
        ("private_weekday_15h_taxfee", "private_weekend_15h_taxfee", r"(?:^|[^0-9])15(?:時間|h)?", True, False),
        ("private_weekday_18h_taxfee", "private_weekend_18h_taxfee", r"(?:^|[^0-9])18(?:時間|h)?", True, False),
        ("private_weekday_21h_taxfee", "private_weekend_21h_taxfee", r"(?:^|[^0-9])21(?:時間|h)?", True, False),
        ("private_weekday_24h_taxfee", "private_weekend_24h_taxfee", r"(?:^|[^0-9])24(?:時間|h)?", True, False),
        ("private_weekday_night8_taxfee", "private_weekend_night8_taxfee", r"ナイト", False, True),
    ]

    time_rows = []
    left_words = [w for w in all_words if w["center_x"] < 280 and 320 < w["center_y"] < 1550]

    left_words.sort(key=lambda w: w["center_y"])
    left_lines = []
    curr_line = []
    for w in left_words:
        if not curr_line or abs(w["center_y"] - curr_line[-1]["center_y"]) < 25:
            curr_line.append(w)
        else:
            left_lines.append(curr_line)
            curr_line = [w]
    if curr_line:
        left_lines.append(curr_line)

    for line in left_lines:
        line_text = "".join([w["text"] for w in line])
        line_y = sum(w["center_y"] for w in line) / len(line)
        for wday_k, wend_k, pattern, is_pack, is_night in time_defs:
            if re.search(pattern, line_text):
                if not any(r["wday_k"] == wday_k for r in time_rows):
                    time_rows.append({
                        "wday_k": wday_k,
                        "wend_k": wend_k,
                        "y": line_y,
                        "is_pack": is_pack,
                        "is_night": is_night,
                        "label": line_text,
                        "wday_val": None,
                        "wend_val": None
                    })
                break

    time_rows.sort(key=lambda r: r["y"])

    # 5. 価格数値の抽出関数
    def get_prices_in_col(center_x_target, x_tolerance=80):
        prices = []
        for w in all_words:
            if is_single_column_store:
                x_match = (w["center_x"] > 300)
            else:
                x_match = (center_x_target - x_tolerance <= w["center_x"] <= center_x_target + x_tolerance)
            
            if x_match and 340 < w["center_y"] < 1550:
                clean_str = w["text"].replace(",", "").replace("円", "")
                m = re.match(r"^(\d{2,5})$", clean_str)
                if m:
                    val = int(m.group(1))
                    if 50 <= val <= 25000:
                        prices.append({"val": val, "y": w["center_y"]})
        unique_p = []
        for p in sorted(prices, key=lambda x: x["y"]):
            if not unique_p or abs(p["y"] - unique_p[-1]["y"]) > 10:
                unique_p.append(p)
        return unique_p

    # 6. 時間行へのマッピング実行
    def map_prices_to_rows(col_prices, val_attr):
        used_indices = set()

        # A. ナイトパック行（最下部）を優先特定し、通常パックから除外
        for r in time_rows:
            if r.get("is_night"):
                best_idx = None
                min_dist = 999999
                for idx, p in enumerate(col_prices):
                    dist = abs(p["y"] - r["y"])
                    if dist < min_dist:
                        min_dist = dist
                        best_idx = idx
                if best_idx is not None and min_dist <= 75:
                    r[val_attr] = col_prices[best_idx]["val"]
                    used_indices.add(best_idx)

        # B. 基本・延長行
        for r in time_rows:
            if not r.get("is_pack") and not r.get("is_night"):
                best_idx = None
                min_dist = 999999
                for idx, p in enumerate(col_prices):
                    if idx in used_indices:
                        continue
                    dist = abs(p["y"] - r["y"])
                    if dist < min_dist:
                        min_dist = dist
                        best_idx = idx
                if best_idx is not None and min_dist <= 65:
                    r[val_attr] = col_prices[best_idx]["val"]
                    used_indices.add(best_idx)

        # C. 通常パック行（3h, 6h, ..., 24h）
        pack_rows = [r for r in time_rows if r.get("is_pack")]
        # ナイトパックや基本延長を除外した通常パック用価格リスト
        pack_prices = [p for idx, p in enumerate(col_prices) if idx not in used_indices and p["val"] >= 500]

        # 直接距離でヒットする通常パックをマッピング
        for r in pack_rows:
            best_idx = None
            min_dist = 999999
            for idx, p in enumerate(pack_prices):
                dist = abs(p["y"] - r["y"])
                if dist < min_dist:
                    min_dist = dist
                    best_idx = idx
            if best_idx is not None and min_dist <= 65:
                r[val_attr] = pack_prices[best_idx]["val"]

        # セル結合補完: 未割り当ての通常パック行には、最も近い通常パック価格を割り当て
        for r in pack_rows:
            if r[val_attr] is None and pack_prices:
                closest = min(pack_prices, key=lambda p: abs(p["y"] - r["y"]))
                r[val_attr] = closest["val"]

        # 単調非減少（時間が増えればパック料金は同額以上）の保証
        last_val = 0
        for r in pack_rows:
            if r[val_attr] is not None:
                if r[val_attr] < last_val:
                    r[val_attr] = last_val
                else:
                    last_val = r[val_attr]

    if has_sub_weekday_weekend:
        wday_prices = get_prices_in_col(target_weekday_x, x_tolerance=75)
        wend_prices = get_prices_in_col(target_weekend_x, x_tolerance=75)
        map_prices_to_rows(wday_prices, "wday_val")
        map_prices_to_rows(wend_prices, "wend_val")

        for r in time_rows:
            if r["wday_val"] is not None:
                result[r["wday_k"]] = r["wday_val"]
            if r["wend_val"] is not None:
                result[r["wend_k"]] = r["wend_val"]
    else:
        col_prices = get_prices_in_col(target_x, x_tolerance=90)
        map_prices_to_rows(col_prices, "wday_val")
        for r in time_rows:
            v = r["wday_val"]
            if v is not None:
                result[r["wday_k"]] = v
                if add_fee:
                    if pack_only_add and not (r.get("is_pack") or r.get("is_night")):
                        result[r["wend_k"]] = v
                    else:
                        result[r["wend_k"]] = v + add_fee
                else:
                    result[r["wend_k"]] = v

    return result


def get_store_price_from_image(store_code: str) -> Optional[Dict[str, Any]]:
    """
    店舗コードから料金表画像を特定し、Cloud Vision API で料金を抽出する。
    1. 幾何学的パーサー (parse_prices_geometric) を優先
    2. 取得項目が少ない場合は従来の正規表現パーサー (parse_prices_from_ocr) にフォールバック
    """
    img_url = fetch_price_image_url(store_code)
    if not img_url:
        return None

    logger.info(f"店舗 [{store_code}] の料金表画像をOCR解析中: {img_url}")
    full_ann, text = ocr_image_url(img_url)
    if not full_ann or not text:
        return None

    # 1. 幾何学的パーサー
    try:
        geo_prices = parse_prices_geometric(full_ann, text)
        valid_keys = [k for k in geo_prices if k.startswith("private_") and geo_prices[k]]
        if len(valid_keys) >= 4:
            logger.info(f"店舗 [{store_code}] 幾何学的OCR抽出成功 ({len(valid_keys)} 項目取得)")
            return geo_prices
    except Exception as e:
        logger.warning(f"店舗 [{store_code}] の幾何学的OCR解析で例外発生: {e}")

    # 2. フォールバック: テキストパーサー
    prices = parse_prices_from_ocr(text)
    return prices

