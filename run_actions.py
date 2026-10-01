import os
import json
import logging
from pathlib import Path
from datetime import datetime

import config
import scraper
import sheets_writer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("github_actions_runner")


def main():
    logger.info("=== GitHub Actions 快活CLUB 完全個室スクレイピング開始 ===")

    # 1. GitHub Secrets から認証キーとスプシIDをロード
    sa_key_json = os.environ.get("GCP_SA_KEY")
    spreadsheet_id = os.environ.get("SPREADSHEET_ID") or config.SPREADSHEET_ID

    temp_cred_file = None
    if sa_key_json:
        temp_cred_file = Path("credentials.json")
        with open(temp_cred_file, "w", encoding="utf-8") as f:
            f.write(sa_key_json)
        config.CREDENTIALS_FILE = str(temp_cred_file.resolve())
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = config.CREDENTIALS_FILE
        logger.info("GitHub Secrets から Google Cloud 認証キーを展開しました。")

    if spreadsheet_id:
        config.SPREADSHEET_ID = spreadsheet_id

    try:
        # 2. 既存の stores.json を読み込み（前回の比較用）
        stores_json_path = Path("stores.json")
        prev_store_map = {}
        if stores_json_path.exists():
            try:
                with open(stores_json_path, "r", encoding="utf-8") as f:
                    prev_list = json.load(f)
                    for item in prev_list:
                        code = str(item.get("店舗コード", ""))
                        if code:
                            prev_store_map[code] = item
                logger.info(f"既存の stores.json から {len(prev_store_map)} 店舗のデータを読み込みました。")
            except Exception as e:
                logger.warning(f"既存 stores.json の読み込み失敗: {e}")

        # 3. 最新データの取得
        current_data = scraper.fetch_all_key_rooms_data()
        logger.info(f"全 {len(current_data)} 店舗の最新データを取得完了！")

        # 4. 差分検知（サイレント値上げチェック）
        price_keys = [
            "平日_基本30分", "平日_延長10分", "平日_3hパック", "平日_6hパック",
            "平日_9hパック", "平日_12hパック", "平日_15hパック", "平日_18hパック",
            "平日_21hパック", "平日_24hパック", "平日_ナイト8h",
            "週末_基本30分", "週末_延長10分", "週末_3hパック", "週末_6hパック",
            "週末_9hパック", "週末_12hパック", "週末_15hパック", "週末_18hパック",
            "週末_21hパック", "週末_24hパック", "週末_ナイト8h"
        ]

        all_diffs = []
        diff_by_store = {}

        for cur in current_data:
            code = str(cur.get("店舗コード", ""))
            prev = prev_store_map.get(code)
            if not prev:
                continue

            store_diffs = []
            for k in price_keys:
                cur_v = cur.get(k)
                prev_v = prev.get(k)
                if cur_v not in [None, "", "-"] and prev_v not in [None, "", "-"]:
                    try:
                        cur_int = int(cur_v)
                        prev_int = int(prev_v)
                        if cur_int != prev_int:
                            diff_amt = cur_int - prev_int
                            diff_str = f"+{diff_amt}円" if diff_amt > 0 else f"{diff_amt}円"
                            d_info = {
                                "店舗コード": code,
                                "都道府県": cur.get("都道府県", ""),
                                "店舗名": cur.get("店舗名", ""),
                                "変更項目": k,
                                "改定前": prev_int,
                                "改定後": cur_int,
                                "差額": diff_str
                            }
                            all_diffs.append(d_info)
                            store_diffs.append({
                                "item": k,
                                "before": prev_int,
                                "after": cur_int,
                                "diff": diff_str
                            })
                    except (ValueError, TypeError):
                        pass

            if store_diffs:
                diff_by_store[code] = store_diffs

        if all_diffs:
            logger.warning(f"【価格改定を検知！】 {len(all_diffs)} 件の料金改定が見つかりました！")
        else:
            logger.info("料金の改定はありませんでした。")

        # 5. 各店舗データに diffs ＆ 最終改定日情報を埋め込んで stores.json を生成
        today_str = datetime.now().strftime("%Y/%m/%d")
        RECENT_DAYS_LIMIT = 30  # 直近の基準（30日以内）

        for cur in current_data:
            code = str(cur.get("店舗コード", ""))
            prev = prev_store_map.get(code, {})

            if code in diff_by_store:
                cur["diffs"] = diff_by_store[code]
                cur["last_price_change_date"] = today_str
            else:
                cur["diffs"] = prev.get("diffs", [])
                cur["last_price_change_date"] = prev.get("last_price_change_date", "")

            # 直近30日以内の改定があるか判定
            is_recent = False
            if cur["last_price_change_date"] and len(cur.get("diffs", [])) > 0:
                try:
                    change_dt = datetime.strptime(cur["last_price_change_date"], "%Y/%m/%d")
                    diff_days = (datetime.now() - change_dt).days
                    if 0 <= diff_days <= RECENT_DAYS_LIMIT:
                        is_recent = True
                except Exception:
                    pass

            cur["has_diff"] = is_recent

        with open(stores_json_path, "w", encoding="utf-8") as f:
            json.dump(current_data, f, ensure_ascii=False, indent=2)
        logger.info(f"Webサイト用データ stores.json を更新しました ({len(current_data)} 店舗)")

        # 6. Googleスプレッドシート連携（キーが存在する場合）
        if temp_cred_file and temp_cred_file.exists():
            logger.info("Googleスプレッドシートへ書き込みを開始します...")
            try:
                success = sheets_writer.update_google_sheets(
                    prices_data=current_data,
                    diffs_data=all_diffs,
                    spreadsheet_id=config.SPREADSHEET_ID
                )
                if success:
                    logger.info("スプレッドシートの更新が完了しました！")
                else:
                    logger.warning("スプレッドシートの更新に失敗しました。")
            except Exception as e:
                logger.error(f"スプレッドシート更新エラー: {e}")

    finally:
        # 一時認証ファイルの削除（セキュリティクリーンアップ）
        if temp_cred_file and temp_cred_file.exists():
            temp_cred_file.unlink()
            logger.info("一時認証ファイルを安全に削除しました。")


if __name__ == "__main__":
    main()
