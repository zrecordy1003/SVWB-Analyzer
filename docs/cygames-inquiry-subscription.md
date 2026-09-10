# Cygames 商用化照会レター（日本語本文＋英訳）

> 送付前に **【】で囲んだ箇所をすべて実数値・実名に置き換えてください。** 空欄のまま送ると
> 「準備不足の照会」と受け取られ、それだけで検討対象から外れます。

## 送付先（2026-09-09 時点で確認）

**第一候補：[商品化・弊社著作物のライセンスに関するお問い合わせ](https://form.cygames.co.jp/license)**
Cygames のお問い合わせポータル（https://form.cygames.co.jp/）の「法人・団体・事業主」区分にある窓口で、
自社 IP を用いた商品化・ライセンス利用の相談を明示的に受け付けています。有料化の可否はライセンスの
問題であり、この窓口が正面です。**個人でも「事業主」として送って差し支えありません**（区分名が
「法人・団体・**事業主**」であるため）。なお同ページには、範囲外の質問には回答しない場合がある旨の
注意書きがあります。件名で「ファンツールの有料機能に関するライセンス照会」と明示してください。

**第二候補：[その他、法人・団体・事業主のお客様からのお問い合わせ](https://form.cygames.co.jp/corporate)**
`/license` から「商品化ではないため対象外」と返された場合、または無回答が続いた場合の再送先。

**送らない方がよい窓口**

- [個人／各種ゲーム・サービスに関するお問い合わせ](https://form.cygames.co.jp/individual) — プレイヤー
  サポート窓口です。ライセンス判断の権限がなく、定型文で終わる可能性が高いです。
- [個人／ご意見・ご要望、およびガイドライン違反・著作権侵害情報のご提供](https://form.cygames.co.jp/individual/request)
  — **通報窓口**です。ここに自分のツールの話を送るのは自己通報に近く、避けてください。
- Shadowverse: Worlds Beyond の [ユーザーサポート](https://shadowverse-wb.com/en/usersupport/) — 同じく
  ゲーム内の問題を扱う窓口です。

> **根拠となる規定：**[Shadowverse: Worlds Beyond Content Guidelines](https://shadowverse-wb.com/en/guideline/)
> には、Cygames の明示的な承認がない限り、ファンサイトの利用者に対していかなる種類の料金も
> （アプリ内課金を含めて）請求してはならない、という趣旨の条項があります。本レターはその
> 「明示的な承認」を求めるものです。この条項に自分から言及することで、規約を読んだ上で
> 事前に照会しているという姿勢が伝わります。

---

---

## 件名

```
【ファンツールの有料機能に関するご相談】Shadowverse: Worlds Beyond 対戦記録ツール「SVWB Analyzer」について
```

---

## 日本語本文

株式会社Cygames
Shadowverse: Worlds Beyond 運営ご担当者様

突然のご連絡失礼いたします。
Shadowverse: Worlds Beyond のプレイヤー向け非公式ツール「SVWB Analyzer」を個人で開発・公開しております、【氏名／ハンドルネーム】と申します。

このたび、本ツールの一部機能を有料（サブスクリプション）とすることを検討しております。貴社の Content Guidelines において、Cygames 様の明示的な承認がない限り利用者に対して料金を請求してはならない旨が定められていると理解しておりますので、実施前に、可否および条件についてご相談させていただきたくご連絡いたしました。

### 1. ツールの概要

「SVWB Analyzer」は、Windows 向けのデスクトップアプリケーションです。プレイヤー自身の対戦履歴を自動で記録し、勝率やデッキ別成績をローカルで集計・表示します。

- 配布形態：GitHub 上で無償公開（【リポジトリ URL】）
- 現在の利用規模：【累計ダウンロード数】件、推定アクティブユーザー【人数】名程度
- 公開開始：【年月】
- ソースコード：自作部分は Apache License 2.0 で全文公開しております

### 2. 技術的な動作範囲（特にご確認いただきたい点）

本ツールがゲームクライアントに対して行う操作は、**画面の読み取りのみ**です。具体的には以下のとおりです。

**行っていること**

- Windows Graphics Capture API による、ゲームウィンドウの画面キャプチャ（メモリ上でのみ処理し、映像は保存いたしません）
- キャプチャ画像に対する画像認識・OCR による、クラス・先攻後攻・勝敗・BP 増減の判定
- 判定結果のローカル SQLite データベースへの保存

**行っていないこと**

- ゲームプロセスのメモリ読み取り・書き込み
- 通信パケットの傍受・解析・改変
- ゲームクライアントのファイル改変、DLL 注入、その他のプログラム的な干渉
- キーボード／マウス操作の自動化（プレイ補助・自動操作の類は一切実装しておりません）
- 未公開情報の取得・表示

すなわち、プレイヤー本人が画面を見て手元にメモを取る行為を自動化したものであり、ゲームの公平性に影響を与える機能は含んでおりません。

### 3. ご相談したい料金体系

現在は全機能を無償で提供しております。今後の構成として、以下を検討しております。

**無料のまま維持する範囲（変更いたしません）**

- 対戦の自動記録
- 勝率・デッキ別成績など、ローカルでの集計と表示
- 現行バージョンで提供中の全機能

**有料（サブスクリプション）を検討している範囲**

- 複数 PC 間でのデータ同期
- 【その他の有料予定機能】

有料の対象としたいのは、**当方が開発したソフトウェアおよび当方が負担するサーバー運用費用**であり、貴社の画像・カードデータ・その他の著作物そのものを販売する意図はございません。金額は月額【金額】円程度を想定しております。

**現在の収益の状況について（ご参考）**

現時点で本ツールに課金機能はございませんが、配布ページに任意の寄付（投げ銭）リンクを掲載しております。
金額は【累計金額】円程度で、寄付の有無によって利用できる機能に差はなく、対価性はございません。透明性の
ため申し添えます。有料化にあたって貴社からご指示がある場合は、この寄付の取り扱いについても従います。

### 4. 併せてお伺いしたい点

上記とは別に、利用者から匿名で収集した対戦結果を集計し、環境全体の統計（クラス別勝率等）としてウェブ上で公開することも検討しております。こちらは無償公開を想定しておりますが、集計結果が貴社タイトルに関する情報の公開にあたるため、可否についてあわせてご教示いただけますと幸いです。

### 5. お願いしたいこと

以下の点について、ご回答またはご指示をいただけますでしょうか。

1. 上記の有料機能の導入が、貴社ガイドラインの範囲内で許容されるか
2. 許容される場合、遵守すべき条件（表記義務、収益規模の上限、機能内容の事前確認など）
3. 許容されない場合、どの部分が問題となるか

なお、貴社のご判断により本件が認められない場合、**有料化は行わず、現行どおり全機能を無償で提供いたします。** また、本ツールそのものの公開停止をご指示いただいた場合には、速やかに従います。

本ツールは非公式のファン制作物であり、貴社が制作・後援・承認したものではない旨を、README・アプリ内・配布ページに明記しております。今後もガイドラインを遵守して運用してまいります。

ご多忙のところ恐縮ですが、ご検討のほどよろしくお願い申し上げます。

【氏名】
メールアドレス：【メールアドレス】
プロジェクト URL：【リポジトリ URL】
【日付】

---

## English version

Cygames, Inc.
Shadowverse: Worlds Beyond Team

Dear Sir or Madam,

My name is 【name】. I am an individual developer and the author of "SVWB Analyzer," an unofficial companion tool for Shadowverse: Worlds Beyond.

I am writing to ask, in advance, whether I may introduce paid subscription features to this tool. I understand from your Content Guidelines that fees of any kind may not be charged to users without the express approval of Cygames. I am therefore writing to seek that approval, and to follow whatever conditions you may set.

### 1. About the tool

SVWB Analyzer is a Windows desktop application that automatically records a player's own match history and displays their win rates and per-deck results locally.

- Distribution: free of charge on GitHub (【repository URL】)
- Current scale: 【total downloads】 downloads, approximately 【number】 active users
- Public since: 【date】
- Source code: my original code is published in full under the Apache License 2.0

### 2. What the tool does and does not do

The only interaction the tool has with the game client is **reading the screen**.

**It does:**

- Capture the game window via the Windows Graphics Capture API (processed in memory only; no video is stored)
- Apply image recognition and OCR to the captured frames to determine class, play order, match result, and BP change
- Store those results in a local SQLite database

**It does not:**

- Read from or write to the game process memory
- Intercept, inspect, or modify network traffic
- Modify game files, inject DLLs, or otherwise interfere with the client
- Automate keyboard or mouse input (there is no play assistance or automation of any kind)
- Access or display any unreleased information

In short, it automates what a player could do by watching their own screen and taking notes. It contains nothing that affects competitive fairness.

### 3. The pricing model I would like to ask about

Everything is currently free. I am considering the following structure.

**Would remain free (no change):**

- Automatic match recording
- Local win-rate and per-deck statistics
- Every feature available in the current version

**Would become part of a paid subscription:**

- Data synchronisation across multiple PCs
- 【other planned paid features】

What I would be charging for is **the software I wrote and the server costs I bear**, not Cygames' images, card data, or other copyrighted works. I anticipate a price of approximately 【amount】 per month.

**Disclosure regarding current income**

The tool has no payment functionality today, but its distribution page carries a voluntary donation link.
Donations to date total approximately 【amount】. They unlock nothing: donors and non-donors have access to
exactly the same features, and nothing is given in return. I mention this in the interest of full disclosure,
and I will follow your instructions regarding this donation link as well.

### 4. A related question

Separately, I am considering aggregating anonymised match results contributed by users and publishing overall metagame statistics (such as win rates by class) on a public web page. This would be free to view, but as it publishes information relating to your title, I would appreciate your guidance on whether it is permissible.

### 5. My requests

I would be grateful for your response or instructions on the following.

1. Whether the paid features described above fall within your guidelines
2. If so, the conditions I must observe (required attribution, revenue limits, prior review of features, and so on)
3. If not, which parts are problematic

If you decide that this is not acceptable, **I will not introduce any paid features and will continue to offer the tool entirely free of charge**, exactly as it is today. If you instruct me to withdraw the tool itself, I will comply promptly.

The tool is clearly identified in its README, inside the application, and on its distribution page as an unofficial fan project that is not created, sponsored, or endorsed by Cygames. I will continue to operate it in accordance with your guidelines.

Thank you very much for your time and consideration.

【name】
Email: 【email】
Project URL: 【repository URL】
【date】
