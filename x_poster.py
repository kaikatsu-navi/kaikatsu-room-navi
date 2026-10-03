import os
import json
import logging
from typing import List, Dict, Any
from requests_oauthlib import OAuth1Session

logger = logging.getLogger("x_poster")

X_POST_URL = "https://api.twitter.com/2/tweets"


def get_x_session():
    """環境変数からX API認証情報を取得してOAuth1セッションを作成"""
    api_key = os.environ.get("X_API_KEY")
    api_secret = os.environ.get("X_API_SECRET")
    access_token = os.environ.get("X_ACCESS_TOKEN")
    access_token_secret = os.environ.get("X_ACCESS_TOKEN_SECRET")

    if not all([api_key, api_secret, access_token, access_token_secret]):
        logger.warning("X APIの認証キーが環境変数に設定されていません。投稿をスキップします。")
        return None

    return OAuth1Session(
        client_key=api_key,
        client_secret=api_secret,
        resource_owner_key=access_token,
        resource_owner_secret=access_token_secret
    )


def post_tweet(text: str) -> bool:
    """Xにツイートを1件投稿する"""
    session = get_x_session()
    if not session:
        return False

    payload = {"text": text}
    try:
        resp = session.post(X_POST_URL, json=payload)
        if resp.status_code in [200, 201]:
            logger.info("✅ Xへのツイート投稿に成功しました！")
            return True
        else:
            logger.error(f"❌ Xへの投稿に失敗しました: {resp.status_code} - {resp.text}")
            return False
    except Exception as e:
        logger.error(f"❌ Xへのリクエスト送信エラー: {e}")
        return False


def post_price_diff_alerts(all_diffs: List[Dict[str, Any]], max_posts: int = 5):
    """
    検知された価格改定情報（all_diffs）をXへ速報ツイートする。
    多すぎる場合はサマリー形式にまとめてAPI制限を防御。
    """
    if not all_diffs:
        logger.info("投稿対象の価格改定データはありません。")
        return

    # 店舗ごとに差分をグルーピング
    stores_map = {}
    for d in all_diffs:
        code = d.get("店舗コード")
        if code not in stores_map:
            stores_map[code] = {
                "name": d.get("店舗名"),
                "pref": d.get("都道府県"),
                "items": []
            }
        stores_map[code]["items"].append(d)

    store_count = len(stores_map)
    logger.info(f"合計 {store_count} 店舗の改定情報をXへ投稿準備中...")

    posted_count = 0
    for code, info in list(stores_map.items())[:max_posts]:
        name = info["name"]
        pref = info["pref"]
        items = info["items"]

        # 値下げ・値上げの判定
        has_decrease = any(str(it.get("差額", "")).startswith("-") for it in items)
        has_increase = any(not str(it.get("差額", "")).startswith("-") for it in items)

        if has_decrease and not has_increase:
            header_tag = "【快活CLUB 値下げ速報 🎉】"
            action_desc = "お得に利用できる値下げが検知されました！"
        elif has_increase and not has_decrease:
            header_tag = "【快活CLUB 価格改定速報 🔔】"
            action_desc = "料金改定（値上げ）が検知されました。"
        else:
            header_tag = "【快活CLUB 料金改定速報 🔔】"
            action_desc = "料金改定が検知されました。"

        # 項目リスト（主要最大3件）
        lines = []
        for it in items[:3]:
            item_name = it.get("変更項目", "").replace("平日_", "").replace("週末_", "")
            before = it.get("改定前")
            after = it.get("改定後")
            diff = it.get("差額")
            lines.append(f"・{item_name}: {before:,}円→{after:,}円 ({diff})")

        if len(items) > 3:
            lines.append(f"・他 {len(items) - 3} 項目")

        item_text = "\n".join(lines)
        target_url = f"https://kaikatsu-navi.github.io/kaikatsu-room-navi/?pref={pref}&q={name}"

        tweet = (
            f"{header_tag}\n"
            f"{pref}「{name}」で{action_desc}\n\n"
            f"{item_text}\n\n"
            f"▼店舗の全パック料金・設備はこちら👇\n"
            f"{target_url}\n"
            f"#快活CLUB #完全個室 #ネカフェ"
        )

        success = post_tweet(tweet)
        if success:
            posted_count += 1

    # 上限を超えた場合のサマリーツイート
    if store_count > max_posts:
        remaining = store_count - max_posts
        summary_tweet = (
            f"【快活CLUB 全国料金改定まとめ 🔔】\n"
            f"本日、さらに他 {remaining} 店舗でも料金改定が検知されています。\n\n"
            f"全国の最新料金・改定履歴一覧はこちらからご確認ください👇\n"
            f"https://kaikatsu-navi.github.io/kaikatsu-room-navi/\n"
            f"#快活CLUB #価格改定"
        )
        post_tweet(summary_tweet)


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        print("Sending test tweet to @panforge_lab...")
        test_tweet = (
            "【システム稼働テスト 🤖】\n"
            "快活CLUB 完全個室ナビ 自動速報ボットの疎通確認テストです。\n"
            "全国415店舗の料金・設備を24時間監視中！\n\n"
            "https://kaikatsu-navi.github.io/kaikatsu-room-navi/\n"
            "#快活CLUB #PanForgeLab"
        )
        success = post_tweet(test_tweet)
        print("Result:", "Success" if success else "Failed")
    else:
        print("X Poster module ready. Run with --test to send a verification tweet.")
