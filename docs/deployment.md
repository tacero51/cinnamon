# デプロイ手順（Cloudflare Pages）

このドキュメントは cinnamon プロジェクトを Cloudflare Pages にデプロイする手順書。

---

## 全体像

```
ローカル変更 → git push → Cloudflareが自動ビルド → 公開URLに反映
```

設定さえ済めば、以降は **git push だけ**でWebサイトが更新される。

---

## 初回セットアップ（一度だけ）

### 1. GitHubリポジトリ作成

```bash
cd cinnamon
git init
git add .
git commit -m "initial: シナモンのスイーツ日記サイト雛形"
```

GitHubで新規リポジトリ `cinnamon` を作成（Public でOK、サイト本体はどのみち公開）→

```bash
git remote add origin https://github.com/<USER>/cinnamon.git
git branch -M main
git push -u origin main
```

### 2. Cloudflare Pages にプロジェクト作成

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログイン（無料アカウント作成）
2. 左メニュー **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. GitHubアカウントを連携し、`cinnamon` リポジトリを選択
4. ビルド設定:
   - **Project name**: `cinnamon`（または好きな名前。これがURLの一部になる: `cinnamon.pages.dev`）
   - **Production branch**: `main`
   - **Framework preset**: `None`（静的サイトなので）
   - **Build command**: 空欄（静的なのでビルド不要）
   - **Build output directory**: `web`
5. **Save and Deploy**

数十秒待つと `https://cinnamon.pages.dev` に公開される。

### 3. URLの共有

`https://cinnamon.pages.dev` を家族に共有する。

---

## 通常の更新フロー

娘がClaudeにスイーツの話をしたら、Claudeが以下を実行:

```bash
# 1. entries.json を更新
# （Claudeが直接編集）

# 2. コミット&プッシュ
cd cinnamon
git add web/data/entries.json
git commit -m "add: ○○のエントリ追加"
git push
```

→ 数十秒で公開URLに反映される。

---

## カスタムドメイン（任意）

`cinnamon.pages.dev` のままでもOK。カスタムドメイン使うなら:

1. ドメインを取得（例: お名前ドットコム、Cloudflare Registrar等）
2. Cloudflare Pages の該当プロジェクト → **Custom domains** → **Set up a custom domain**
3. DNSレコードを案内通りに設定

→ `cinnamon.example.com` のようなURLで公開可能。

---

## 将来の拡張パス

Cloudflareは静的サイトから始めて段階的に動的化できる。

| 段階 | 機能 | Cloudflareサービス |
|---|---|---|
| 今 | 静的サイト | Pages |
| 次 | フォーム送信・API | Workers |
| 後 | DB（コメント・いいね） | D1（SQLite） |
| 後 | 画像保存 | R2（10GB無料） |
| 後 | 認証 | Cloudflare Access |
| 後 | LLM・画像生成 | Workers AI |

---

## ローカル確認

開発中は以下でブラウザで見られる:

```bash
cd cinnamon/web
python3 -m http.server 8765
# → http://localhost:8765/
```

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| デプロイ後もサイトが古いまま | ブラウザキャッシュ | スーパーリロード（Cmd+Shift+R）or プライベートウィンドウ |
| 404 Not Found | Build output directory が間違い | Cloudflare設定で `web` を指定しているか確認 |
| エントリが表示されない | `entries.json` の JSON 構文エラー | ブラウザDevToolsのコンソール確認 |

---

## 参考

- [Cloudflare Pages公式ドキュメント](https://developers.cloudflare.com/pages/)
- [Cloudflare Pages 料金](https://developers.cloudflare.com/pages/platform/limits/) — 無料プランで月500ビルド・無制限帯域
