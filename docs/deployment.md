# デプロイと安全な運用

`cinnamon` は Cloudflare Worker + R2 で動く、**家族限定**のスイーツ日記です。HTML、JavaScript、API、写真のすべてを、ログインフォームと署名済みセッションCookieの内側に置きます。

```text
子どもの端末（Passwordsの自動入力）
  → Cloudflare Worker（ログイン・署名済みCookie・安全ヘッダー）
      → 静的サイト / API
      → Images bindingでWebPへ再エンコード
      → R2（entries.jsonとEXIFなしの写真）
```

写真の原本は新規保存しません。ブラウザ側でもEXIF/GPSを読まず、GPSの逆ジオコーディングも使用しません。

## 初回の安全な設定

Cloudflare Dashboard の **Workers & Pages → cinnamon → Settings → Variables and Secrets** で、次の3つを `Secret` として登録します。

- `LOGIN_USERNAME`
- `LOGIN_PASSWORD`
- `SESSION_SIGNING_KEY`

`LOGIN_USERNAME` / `LOGIN_PASSWORD` はフォームで照合する家族用ログイン情報です。HTTP Basic認証は使いません。パスワードと `SESSION_SIGNING_KEY` は長くランダムなものにし、親がKeychainにのみ保存します。ソースコード、`wrangler.jsonc`、Git、チャット、共有メモには書きません。

`wrangler.jsonc` の `secrets.required` により、この3つが未設定なら `wrangler deploy` は失敗します。Worker側も、秘密がない場合は公開状態に戻らず503を返します。

`SESSION_SIGNING_KEY` をローテーションすると、全端末のログインCookieが失効します。家族用パスワードを変更したときは、同時にローテーションしてください。

次の設定はコードで必須です。

- `assets.run_worker_first: true` — 静的HTML/JS/CSSもWorkerを通して認証する
- `preview_urls: false` — 古いWorkerバージョンのプレビューURLを新規発行しない
- HTTPはログイン前にHTTPSへ308リダイレクトし、HTTPSではHSTSを返す

## デプロイ前の棚卸し

Cloudflare Dashboardで、次がすべて満たされることを確認してからデプロイします。

1. R2バケット `cinnamon-photos` の **Public Development URL (`r2.dev`)** と **Custom Domain** が無効
2. 古いCloudflare Pages、別Worker、カスタムドメイン、branch aliasが同じ日記やR2を公開していない
3. Workerの既存Version Preview URLが無効で、過去の未認証バージョンを直接開けない
4. 写真の元データが親の写真ライブラリ/iCloud等に残っていることを確認する

1つでも未確認なら、写真移行の最終削除は実行しません。

## 通常のデプロイ

```bash
cd cinnamon
npx wrangler deploy
```

デプロイ後、HTTPのURLはログイン前にHTTPSへリダイレクトされることを確認します。続けて、HTTPSの未認証状態で以下を確認します。

- `/` は `/login` へ遷移し、ユーザー名・パスワード欄が表示される
- `/api/entries` と既知の `/photos/...` は `401` になる
- いずれのレスポンスにも `WWW-Authenticate` が付かず、iPhoneのBasic認証ダイアログが出ない
- ログイン成功時の `Set-Cookie` が `Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/` を持ち、`Domain` を持たない

ログイン済みの親端末では、閲覧・追加・編集・削除ができることも確認します。iPhoneでは通常のHTMLフォームなので、最初に親が資格情報をPasswordsへ保存すれば、その後は自動入力を使えます。Macの「login」キーチェーンだけではiPhoneへの同期は保証されません。レスポンスには `Cache-Control: private, no-store` が付きます。

## 同時更新と古い画面

- `GET /api/entries` は保存時点の `ETag` と同じ値を `X-Entries-Version` にも返す。配信時の圧縮でETagが弱い表記へ変わるため、画面は専用ヘッダーの値を使う。`PUT /api/entries/:id` と `DELETE /api/entries/:id` は、編集開始時のETagを `If-Match` に指定する。省略は428、古い版は409。
- 新規投稿を含む正本の保存は、R2の `onlyIf` 条件で読み取り時点のETagを照合する。条件不一致では保存せず409を返す。初回作成も `If-None-Match: *` で保護する。
- 競合時はフォームの入力・選択写真を保持する。一覧へ戻ると再取得するので、変更内容を確認してから編集を開き直す。古いフロントエンドが残ったタブでは、ページを再読み込みする。
- 通信失敗では保存が済んでいる可能性があるため、自動再送信しない。一覧で結果を確認してから再操作する。保存結果が不明なとき、新しい写真は参照切れ防止のため残す。

## 既存写真の一回限りの移行

移行は、**安全化して参照を切り替える準備**と、**親が確認した後に旧原本を削除する確定**の二段階です。準備だけでは旧JPEGを削除しません。

### 1. メンテナンス開始

1. 家族の端末で日記を閉じ、投稿・編集・削除が終わっていることを確認する
2. 一時的なランダム値を `PHOTO_MIGRATION_TOKEN` というWorker Secretとして登録する
3. 少なくとも2分待つ

このSecretが存在する間、通常の `POST` / `PUT` / `DELETE` は503になり、`entries.json`の競合を防ぎます。

### 2. 準備と参照切替

親がログイン済みの端末で移行トークンを使って、次を一度呼びます。

```text
POST /api/admin/sanitize-existing-photos
Header: X-Photo-Migration-Token: <一時トークン>
```

この処理は次の順で動きます。

1. 既存写真をWebPへ再エンコードし、R2に保存する
2. 保存済みWebPを再読込して画像としてデコードできることを確認する
3. 切替前の `entries.json` をR2へバックアップする
4. `entries.json` の写真参照を一括で新WebPへ切り替える

成功時は `"phase": "ready_to_finalize"` を返します。この時点では旧JPEGや過去の孤立写真はまだ残っています。

### 3. 親による確認

確定削除の前に、少なくとも以下を確認します。

1. 日記上で全写真が表示されること
2. 新しいWebPをダウンロードして、全件でメタデータ検査が成功すること

   ```bash
   node scripts/verify-photo-metadata.mjs <downloaded-webp-files...>
   ```

3. `entries.json` の件数と写真数が移行前の記録と一致すること
4. ログインCookieなしでは旧写真URLが401になること

Cloudflare ImagesのWebP出力は仕様上すべてのメタデータを破棄しますが、削除前に実ファイルを検査します。

### 4. 旧原本の削除を確定

上記を確認できた場合だけ、同じログイン済み端末と移行トークンで次を呼びます。

```text
POST /api/admin/finalize-photo-sanitization
Header: X-Photo-Migration-Token: <一時トークン>
```

成功条件は `"ok": true`、`"delete_failures": 0` です。この処理は `photos/` 配下を再走査し、`photos/secure/*.webp` 以外の旧原本・孤立原本も削除します。

その後、R2で `photos/secure/*.webp` 以外が0件であること、旧URLが404であることを確認し、`PHOTO_MIGRATION_TOKEN` をCloudflareから削除します。削除後に通常の記録更新が再開します。

## 注意

- 過去に公開されていた写真を第三者がすでに保存している場合、そのコピーまでは消せません
- ログインCookieは家族運用のための保護です。外部発表は、非公開日記から分けて親が選んだ成果物だけを掲載します
- `web/data/entries.json` はサンプルです。本番データの正本はR2の `data/entries.json` です
