import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

# 保存ディレクトリ
DATA_DIR = BASE_DIR / "data"
HISTORY_DIR = DATA_DIR / "history"

# Google Sheets 設定
# サービスアカウントキー (JSON) のファイルパス
# デフォルトはプロジェクトルート直下の credentials.json
CREDENTIALS_FILE = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", str(BASE_DIR / "credentials.json"))

# 書き込み先の Google スプレッドシート ID
# 例: https://docs.google.com/spreadsheets/d/<この部分>/edit
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "")

# スプレッドシート内のシート名
SHEET_NAME_PRICES = "完全個室_最新料金"
SHEET_NAME_DIFF = "価格改定履歴"

# スクレイピング設定
SHOP_JS_URL = "https://www.kaikatsu.jp/shop/data/shop.js"
PRICE_JSON_URL_TEMPLATE = "https://www.kaikatsu.jp/public/{store_code}.json"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
MAX_WORKERS = 15
REQUEST_TIMEOUT = 10
