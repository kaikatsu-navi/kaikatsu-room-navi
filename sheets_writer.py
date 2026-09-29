import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
import urllib.parse
import urllib.request
import json
from ocr_reader import get_auth_token

import config

logger = logging.getLogger(__name__)


def _normalize_cell_val(val: Any) -> str:
    """比較用の正規化"""
    if val is None:
        return ""
    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    s = str(val).strip()
    if s.upper() in ["TRUE", "FALSE"]:
        return s.upper()
    if s.startswith("=HYPERLINK(") and '", "' in s:
        parts = s.split('", "')
        if len(parts) >= 2:
            return parts[-1].rstrip('")').strip()
    return s

try:
    import gspread
    from google.oauth2.service_account import Credentials
    HAS_GSPREAD = True
except ImportError:
    HAS_GSPREAD = False

# チェックボックス化する設備・アイコン項目の定義
CHECKBOX_COLS = [
    # 設備・サービス（オレンジ）
    "個室WEB予約", "無料シャワー", "有料シャワー", "コインランドリー",
    "駐車場", "飲み放題カフェ", "100円モーニング", "無料トースト",
    "ソフトクリーム", "アルコール販売", "タオル使い放題", "加熱式たばこエリア",
    # 席・部屋タイプ（グリーン）
    "個室_多機能", "個室_フラット", "ワイドルーム", "VIPフラット",
    "リクライニング", "フルフラット", "マッサージ",
    # アミューズメント（ブルー）
    "カラオケ", "ダーツ", "ビリヤード"
]

SERVICE_COLS = [
    "個室WEB予約", "無料シャワー", "有料シャワー", "コインランドリー",
    "駐車場", "飲み放題カフェ", "100円モーニング", "無料トースト",
    "ソフトクリーム", "アルコール販売", "タオル使い放題", "加熱式たばこエリア"
]

ROOM_COLS = [
    "個室_多機能", "個室_フラット", "ワイドルーム", "VIPフラット",
    "リクライニング", "フルフラット", "マッサージ"
]

AMUSEMENT_COLS = [
    "カラオケ", "ダーツ", "ビリヤード"
]


def check_credentials() -> Tuple[bool, str]:
    """
    サービスアカウント設定の妥当性をチェックする。
    """
    if not HAS_GSPREAD:
        return False, "gspread または google-auth がインストールされていません。"

    cred_path = Path(config.CREDENTIALS_FILE)
    if not cred_path.exists():
        return False, f"認証ファイルが見つかりません: {cred_path.resolve()}"

    if not config.SPREADSHEET_ID:
        return False, "スプレッドシートID (SPREADSHEET_ID) が設定されていません。"

    return True, "OK"


def get_gspread_client() -> Any:
    """
    gspreadクライアントを取得する。
    """
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]
    credentials = Credentials.from_service_account_file(
        config.CREDENTIALS_FILE,
        scopes=scopes
    )
    return gspread.authorize(credentials)


def update_google_sheets(
    prices_data: List[Dict[str, Any]],
    diffs_data: Optional[List[Dict[str, Any]]] = None,
    spreadsheet_id: Optional[str] = None
) -> bool:
    """
    Googleスプレッドシートへ料金データ、設備チェックボックス、価格変更差分を書き込む。
    """
    target_id = spreadsheet_id or config.SPREADSHEET_ID

    if not HAS_GSPREAD:
        logger.error("gspread ライブラリが利用できません。")
        return False

    cred_path = Path(config.CREDENTIALS_FILE)
    if not cred_path.exists():
        logger.error(f"サービスアカウントの認証キーが見つかりません: {cred_path.resolve()}")
        return False

    if not target_id:
        logger.error("スプレッドシートIDが未設定です。")
        return False

    try:
        logger.info("Google Sheets API 認証中...")
        gc = get_gspread_client()
        logger.info(f"スプレッドシートを開いています (ID: {target_id})...")
        sh = gc.open_by_key(target_id)

        # 1. 「完全個室_最新料金」シートの更新（設備チェックボックス・差分赤文字・最終確認日付き）
        _write_prices_sheet(sh, prices_data)

        # 2. 「価格改定履歴」シートの追記（差分がある場合）
        if diffs_data:
            _append_diffs_sheet(sh, diffs_data)

        logger.info("Googleスプレッドシートへの同期が完了しました！")
        return True
    except Exception as e:
        logger.error(f"Googleスプレッドシートの更新中にエラーが発生しました: {e}", exc_info=True)
        return False


def _get_existing_red_cells(target_id: str, sheet_name: str) -> Set[Tuple[int, int]]:
    """
    既存スプレッドシートから現在赤文字（強調）になっているセルの座標 (row_idx, col_idx) を取得する。
    """
    red_cells = set()
    try:
        token = get_auth_token()
        if not token:
            return red_cells

        sheet_param = urllib.parse.quote(sheet_name)
        url = (
            f"https://sheets.googleapis.com/v4/spreadsheets/{target_id}"
            f"?ranges={sheet_param}!A1:AZ500"
            "&fields=sheets(data(rowData(values(userEnteredFormat(textFormat(foregroundColor))))))"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        sheets = data.get("sheets", [])
        if sheets and "data" in sheets[0] and sheets[0]["data"]:
            rows = sheets[0]["data"][0].get("rowData", [])
            for r_idx, r in enumerate(rows):
                for c_idx, cell in enumerate(r.get("values", [])):
                    fg = cell.get("userEnteredFormat", {}).get("textFormat", {}).get("foregroundColor", {})
                    # 赤成分が高く緑成分が低い（赤文字判定）
                    if fg.get("red", 0) > 0.5 and fg.get("green", 0) < 0.2:
                        red_cells.add((r_idx, c_idx))
    except Exception as e:
        logger.debug(f"既存赤文字セルの取得スキップ: {e}")

    return red_cells


def _write_prices_sheet(sh: Any, prices_data: List[Dict[str, Any]]) -> None:
    """
    最新料金シートを更新する。
    - 設備・アミューズメント項目を本物のチェックボックス（BOOLEAN）として配置。
    - 最右列に「最終確認日」を追加。
    - 初回は一律で巡回日（今日の日付）をセット。
    - 2回目以降は、変更のあったセル・新規店舗の文字色を「赤色（太字）」にし、
      その行の最終確認日を今日の日付に更新する。
    """
    sheet_name = config.SHEET_NAME_PRICES
    try:
        ws = sh.worksheet(sheet_name)
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=sheet_name, rows=len(prices_data) + 50, cols=70)

    if not prices_data:
        return

    # シートの列数が足りない場合は拡張
    if ws.col_count < 70:
        ws.resize(cols=70)

    today_str = datetime.now().strftime("%Y/%m/%d")

    # 基準ヘッダー定義（一番左（A列）に「最終確認日」を配置！）
    base_headers = [k for k in prices_data[0].keys() if k != "最終確認日"]
    headers = ["最終確認日"] + base_headers
    last_check_col_idx = 0

    # 既存のスプレッドシートデータを取得して比較用マップを作成
    existing_all = ws.get_all_values()
    prev_store_map = {}
    is_initial_run = True

    if existing_all and len(existing_all) >= 2:
        existing_headers = existing_all[0]
        if "最終確認日" in existing_headers:
            is_initial_run = False
            last_check_idx_in_existing = existing_headers.index("最終確認日")
            store_code_idx = existing_headers.index("店舗コード") if "店舗コード" in existing_headers else 0

            for r in existing_all[1:]:
                if not r or len(r) <= store_code_idx:
                    continue
                code = r[store_code_idx].strip()
                if not code:
                    continue
                row_dict = {}
                for h_idx, h_name in enumerate(existing_headers):
                    if h_idx < len(r):
                        row_dict[h_name] = r[h_idx]
                prev_store_map[code] = {
                    "data": row_dict,
                    "last_checked": r[last_check_idx_in_existing] if last_check_idx_in_existing < len(r) else ""
                }

    # 既存の赤文字セルの位置を取得（同一日内の複数回実行時に赤文字を維持するため）
    existing_red_cells = _get_existing_red_cells(sh.id, sheet_name)

    rows = [headers]
    highlight_cells: List[Tuple[int, int]] = []
    new_stores_count = 0
    changed_cells_count = 0

    for i, item in enumerate(prices_data):
        row_idx = i + 1  # 0-indexed for Sheets API
        code = str(item.get("店舗コード", "")).strip()

        if is_initial_run or code not in prev_store_map:
            last_checked = today_str
            item["最終確認日"] = last_checked

            if not is_initial_run and code not in prev_store_map:
                new_stores_count += 1
                for c_idx in range(len(headers)):
                    highlight_cells.append((row_idx, c_idx))
        else:
            prev_info = prev_store_map[code]
            prev_row_data = prev_info["data"]
            prev_last_checked = prev_info["last_checked"] or today_str

            row_has_change = False

            # 同一日内の複数回実行の場合：既存の赤文字セルをそのまま維持！
            is_same_day_run = (prev_last_checked == today_str)
            if is_same_day_run:
                for c_idx in range(len(headers)):
                    if (row_idx, c_idx) in existing_red_cells:
                        highlight_cells.append((row_idx, c_idx))
                        if c_idx != last_check_col_idx:
                            row_has_change = True

            for c_idx, h in enumerate(headers):
                if h == "最終確認日":
                    continue
                if h not in prev_row_data:
                    # スプレッドシートに新設された列は価格改定ではないためハイライト対象外
                    continue
                new_val_str = _normalize_cell_val(item.get(h))
                old_val_str = _normalize_cell_val(prev_row_data.get(h))

                if new_val_str != old_val_str:
                    row_has_change = True
                    changed_cells_count += 1
                    if (row_idx, c_idx) not in highlight_cells:
                        highlight_cells.append((row_idx, c_idx))

            if row_has_change:
                last_checked = today_str
                if (row_idx, last_check_col_idx) not in highlight_cells:
                    highlight_cells.append((row_idx, last_check_col_idx))
            else:
                last_checked = prev_last_checked

            item["最終確認日"] = last_checked

        # 行データ構築 (boolはTrue/Falseのまま渡すとスプシ側でチェックボックス値になる)
        row = []
        for h in headers:
            val = item.get(h, "")
            if h == "店舗名":
                # 店舗詳細ページへの公式リンク数式を設定！
                store_code = str(item.get("店舗コード", "")).strip()
                store_name = str(val).strip()
                if store_code:
                    url = f"https://www.kaikatsu.jp/shop/detail/{store_code}.html"
                    val = f'=HYPERLINK("{url}", "{store_name}")'
            elif val is None:
                val = ""
            row.append(val)
        rows.append(row)

    # 1. 値の一括更新 (USER_ENTERED で数式を認識させる)
    ws.clear()
    ws.update("A1", rows, value_input_option="USER_ENTERED")
    logger.info(f"シート [{sheet_name}] の値を一括更新しました (全 {len(prices_data)} 行, {len(headers)} 列)")

    # 2. 書式設定 & チェックボックス設定
    total_rows = len(rows)
    total_cols = len(headers)
    requests = []

    # フィルタで非表示行があると書式やチェックボックスの適用がスキップされるため、
    # 一旦フィルタをクリアして全行を表示状態にする
    requests.append({
        "clearBasicFilter": {
            "sheetId": ws.id
        }
    })

    # 全体リセット: ヘッダー以外のデータ範囲を黒文字・太字解除
    requests.append({
        "repeatCell": {
            "range": {
                "sheetId": ws.id,
                "startRowIndex": 1,
                "endRowIndex": total_rows,
                "startColumnIndex": 0,
                "endColumnIndex": total_cols,
            },
            "cell": {
                "userEnteredFormat": {
                    "textFormat": {
                        "foregroundColor": {"red": 0.0, "green": 0.0, "blue": 0.0},
                        "bold": False,
                    }
                }
            },
            "fields": "userEnteredFormat.textFormat(foregroundColor,bold)",
        }
    })

    # ヘッダー行の書式設定（基本料金・情報はブルーグレー）
    requests.append({
        "repeatCell": {
            "range": {
                "sheetId": ws.id,
                "startRowIndex": 0,
                "endRowIndex": 1,
                "startColumnIndex": 0,
                "endColumnIndex": total_cols,
            },
            "cell": {
                "userEnteredFormat": {
                    "backgroundColor": {"red": 0.90, "green": 0.94, "blue": 0.98},
                    "textFormat": {
                        "foregroundColor": {"red": 0.1, "green": 0.2, "blue": 0.4},
                        "bold": True,
                    },
                    "horizontalAlignment": "CENTER",
                }
            },
            "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        }
    })

    # ヘッダーの色分け（アイコンの画像とお揃いのカラー！）
    # 設備・サービス: オレンジ系
    for col_name in SERVICE_COLS:
        if col_name in headers:
            c_idx = headers.index(col_name)
            requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": ws.id,
                        "startRowIndex": 0,
                        "endRowIndex": 1,
                        "startColumnIndex": c_idx,
                        "endColumnIndex": c_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColor": {"red": 1.0, "green": 0.92, "blue": 0.82},  # 淡いオレンジ
                            "textFormat": {"foregroundColor": {"red": 0.8, "green": 0.3, "blue": 0.0}, "bold": True},
                            "horizontalAlignment": "CENTER",
                        }
                    },
                    "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
                }
            })

    # 席・部屋タイプ: グリーン系
    for col_name in ROOM_COLS:
        if col_name in headers:
            c_idx = headers.index(col_name)
            requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": ws.id,
                        "startRowIndex": 0,
                        "endRowIndex": 1,
                        "startColumnIndex": c_idx,
                        "endColumnIndex": c_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColor": {"red": 0.88, "green": 0.96, "blue": 0.88},  # 淡いグリーン
                            "textFormat": {"foregroundColor": {"red": 0.1, "green": 0.5, "blue": 0.1}, "bold": True},
                            "horizontalAlignment": "CENTER",
                        }
                    },
                    "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
                }
            })

    # アミューズメント: ライトブルー系
    for col_name in AMUSEMENT_COLS:
        if col_name in headers:
            c_idx = headers.index(col_name)
            requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": ws.id,
                        "startRowIndex": 0,
                        "endRowIndex": 1,
                        "startColumnIndex": c_idx,
                        "endColumnIndex": c_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColor": {"red": 0.86, "green": 0.93, "blue": 1.0},  # 淡いブルー
                            "textFormat": {"foregroundColor": {"red": 0.0, "green": 0.35, "blue": 0.75}, "bold": True},
                            "horizontalAlignment": "CENTER",
                        }
                    },
                    "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
                }
            })

    # チェックボックス設定（CHECKBOX_COLS に含まれる連続列を一括で BOOLEAN 入力規則化 & 中央揃え）
    cb_indices = [headers.index(col_name) for col_name in CHECKBOX_COLS if col_name in headers]
    if cb_indices:
        start_cb = min(cb_indices)
        end_cb = max(cb_indices) + 1
        requests.append({
            "setDataValidation": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": 1,
                    "endRowIndex": total_rows,
                    "startColumnIndex": start_cb,
                    "endColumnIndex": end_cb,
                },
                "rule": {
                    "condition": {
                        "type": "BOOLEAN"
                    },
                    "showCustomUi": True,
                }
            }
        })
        requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": 1,
                    "endRowIndex": total_rows,
                    "startColumnIndex": start_cb,
                    "endColumnIndex": end_cb,
                },
                "cell": {
                    "userEnteredFormat": {
                        "horizontalAlignment": "CENTER",
                    }
                },
                "fields": "userEnteredFormat.horizontalAlignment",
            }
        })

    # 全列を対象としたフィルタ枠を再配置（全行表示状態）
    requests.append({
        "setBasicFilter": {
            "filter": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": 0,
                    "endRowIndex": total_rows,
                    "startColumnIndex": 0,
                    "endColumnIndex": total_cols
                }
            }
        }
    })

    # まず基本書式・ヘッダー・チェックボックス・フィルタ枠を一括送信
    if requests:
        sh.batch_update({"requests": requests})

    # 変更セル・新規店舗セルの赤文字化 (Red text & Bold) は上限エラーを避けるため500件ずつ分割送信
    highlight_requests = []
    for r_idx, c_idx in highlight_cells:
        highlight_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": r_idx,
                    "endRowIndex": r_idx + 1,
                    "startColumnIndex": c_idx,
                    "endColumnIndex": c_idx + 1,
                },
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {
                            "foregroundColor": {"red": 0.85, "green": 0.0, "blue": 0.0},
                            "bold": True,
                        }
                    }
                },
                "fields": "userEnteredFormat.textFormat(foregroundColor,bold)",
            }
        })

    if highlight_requests:
        CHUNK_SIZE = 500
        for k in range(0, len(highlight_requests), CHUNK_SIZE):
            chunk = highlight_requests[k:k + CHUNK_SIZE]
            sh.batch_update({"requests": chunk})

    logger.info(f"書式とチェックボックスを更新しました (新規店舗: {new_stores_count} 件, 変更セル: {changed_cells_count} 箇所)")

    try:
        ws.freeze(rows=1)
    except Exception:
        pass


def _append_diffs_sheet(sh: Any, diffs_data: List[Dict[str, Any]]) -> None:
    """
    価格改定履歴シートに差分行を追記する。
    """
    sheet_name = config.SHEET_NAME_DIFF
    try:
        ws = sh.worksheet(sheet_name)
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=sheet_name, rows=100, cols=15)
        headers = ["検知日時", "店舗コード", "都道府県", "市区町村", "店舗名", "変更項目", "改定前", "改定後", "差額"]
        ws.update("A1", [headers])
        try:
            ws.format("A1:I1", {
                "backgroundColor": {"red": 1.0, "green": 0.9, "blue": 0.8},
                "textFormat": {"bold": True},
                "horizontalAlignment": "CENTER"
            })
            ws.freeze(rows=1)
        except Exception:
            pass

    headers = ["検知日時", "店舗コード", "都道府県", "市区町村", "店舗名", "変更項目", "改定前", "改定後", "差額"]
    append_rows = []
    for d in diffs_data:
        row = [d.get(h, "") for h in headers]
        append_rows.append(row)

    ws.append_rows(append_rows)
    logger.info(f"シート [{sheet_name}] に価格変更 {len(diffs_data)} 件を追記しました！")
